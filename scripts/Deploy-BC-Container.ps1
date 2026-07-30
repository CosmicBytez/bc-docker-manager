<#
.SYNOPSIS
    Business Central Container Deployment Script v1.1 (Docker-Direct)

.DESCRIPTION
    Deploys BC containers using direct docker commands instead of BcContainerHelper.
    This bypasses HNS issues (0x803b0013) that occur with New-BcContainer on Windows 11 24H2.
    Designed for non-interactive use via the BC Docker Manager app.

.REQUIREMENTS
    - Windows 11 Pro/Enterprise or Windows Server with containers
    - Docker Engine installed and running
    - Administrator privileges
    - Internet access for artifact downloads

.PARAMETER Version
    BC Version: 13-27, Latest, NextMinor, or NextMajor

.PARAMETER ContainerName
    Name for the container (must start with bcserver-)

.PARAMETER Auth
    Authentication type: Windows or NavUserPassword

.PARAMETER Username
    Admin username for NavUserPassword auth (default: admin)

.PARAMETER Password
    Admin password for NavUserPassword auth (required for NavUserPassword)

.PARAMETER PasswordFile
    Path to a file containing the admin password. Used by the BC Docker Manager app
    so the password never appears on the command line. The file is deleted as soon
    as it has been read. Takes precedence over -Password.

.PARAMETER Isolation
    Container isolation mode: process or hyperv (default: process)

.PARAMETER MemoryLimit
    Container memory limit (default: 8G)

.PARAMETER EnableScheduledBackups
    Create daily backup scheduled task

.PARAMETER Country
    Country/region code for BC artifacts (default: us)

.EXAMPLE
    .\Deploy-BC-Container.ps1 -Version Latest -ContainerName bcserver-latest -Auth NavUserPassword -Username admin -Password "SecurePass123!"

.NOTES
    Author: CosmicBytez IT Operations
    Version: 1.1
    Last Updated: 2026-01-13

    Changes in 1.1:
    - Fixed backup volume mount (C:\BCBackups now mounted in container)
    - Fixed AES key encoding (comma-separated text instead of binary)
    - Fixed port mappings to use standard BC internal ports (80, 443, 7045-7049)
    - Added Developer Services port (7048) for AL Language extension

    This script uses direct docker commands to avoid BcContainerHelper HNS issues.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','Latest','NextMinor','NextMajor')]
    [string]$Version,

    [Parameter(Mandatory=$true)]
    [string]$ContainerName,

    [Parameter(Mandatory=$false)]
    [ValidateSet('Windows','NavUserPassword')]
    [string]$Auth = 'NavUserPassword',

    [Parameter(Mandatory=$false)]
    [string]$Username = 'admin',

    [Parameter(Mandatory=$false)]
    [string]$Password,

    [Parameter(Mandatory=$false)]
    [string]$PasswordFile,

    [Parameter(Mandatory=$false)]
    [ValidateSet('process','hyperv')]
    [string]$Isolation = 'process',

    [Parameter(Mandatory=$false)]
    [string]$MemoryLimit = '8G',

    [Parameter(Mandatory=$false)]
    [switch]$EnableScheduledBackups,

    [Parameter(Mandatory=$false)]
    [switch]$InstallTestToolkit,

    [Parameter(Mandatory=$false)]
    [string]$Country = 'us'
)

$ErrorActionPreference = 'Stop'
$scriptVersion = "1.1"

#region Configuration
$backupRootPath = "C:\BCBackups"
$scriptsPath = "C:\Scripts"
$backupRetentionDays = 7
$backupTime = "02:00"
$bcContainerHelperPath = "C:\ProgramData\BcContainerHelper"
#endregion

#region Helper Functions
function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'SUCCESS')]
        [string]$Level = 'INFO'
    )

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $color = switch ($Level) {
        'INFO'    { 'White' }
        'WARN'    { 'Yellow' }
        'ERROR'   { 'Red' }
        'SUCCESS' { 'Green' }
    }
    Write-Host "[$timestamp] [$Level] $Message" -ForegroundColor $color
}

function Test-Prerequisites {
    Write-Log "Checking prerequisites..."

    # Check for Administrator privileges
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        throw "This script requires Administrator privileges. Please run PowerShell as Administrator."
    }
    Write-Log "Administrator privileges: OK" -Level SUCCESS

    # Check Docker
    try {
        $dockerVersion = docker version --format '{{.Server.Version}}' 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Docker is not running"
        }
        Write-Log "Docker Engine: $dockerVersion" -Level SUCCESS
    }
    catch {
        throw "Docker is not installed or not running. Please install Docker Engine first."
    }

    return $true
}

function Get-BCVersionNumber {
    param([string]$Version)

    switch ($Version) {
        "Latest"    { return 99 }
        "NextMinor" { return 98 }
        "NextMajor" { return 97 }
        default     { return [int]$Version }
    }
}

function Get-VersionPorts {
    param([string]$Version)

    $baseVersion = Get-BCVersionNumber -Version $Version

    # Calculate version-specific ports to avoid conflicts
    $ports = @{
        WebPort      = 8500 + $baseVersion
        HttpsPort    = 9400 + $baseVersion
        DevPort      = 7000 + $baseVersion        # File Share (maps to 7049)
        DevServices  = 7100 + $baseVersion        # Developer Services (maps to 7048)
        SoapPort     = 6000 + ($baseVersion * 10) # Management (maps to 7045)
        ODataPort    = 6100 + ($baseVersion * 10) # Client Services (maps to 7046)
    }

    return $ports
}

function Get-ArtifactInfo {
    param(
        [string]$Version,
        [string]$Country
    )

    Write-Log "Retrieving BC artifact information..."

    # Import BcContainerHelper just for artifact URL resolution
    try {
        Import-Module BcContainerHelper -Force -ErrorAction Stop
    }
    catch {
        throw "BcContainerHelper module required for artifact URL resolution. Install with: Install-Module BcContainerHelper -Force"
    }

    # Determine version parameter for Get-BcArtifactUrl
    $versionParam = switch ($Version) {
        "Latest"    { @{ select = "Latest" } }
        "NextMinor" { @{ select = "NextMinor" } }
        "NextMajor" { @{ select = "NextMajor" } }
        default     { @{ version = $Version } }
    }

    $artifactUrl = Get-BcArtifactUrl -type Sandbox -country $Country @versionParam

    if (-not $artifactUrl) {
        throw "Failed to get artifact URL for version $Version"
    }

    Write-Log "Artifact URL: $artifactUrl" -Level SUCCESS

    # Extract version info from URL
    # URL format: https://bcartifacts.../sandbox/27.2.42879.44461/us
    if ($artifactUrl -match '/sandbox/(\d+\.\d+\.\d+\.\d+)/') {
        $fullVersion = $Matches[1]
    }
    else {
        $fullVersion = $Version
    }

    return @{
        ArtifactUrl = $artifactUrl
        FullVersion = $fullVersion
    }
}

function Get-BCImageTag {
    param([string]$Isolation)

    # Use the appropriate Windows container image
    # For Windows 11 24H2, use ltsc2025
    $osVersion = [System.Environment]::OSVersion.Version

    if ($osVersion.Build -ge 26100) {
        return "mcr.microsoft.com/businesscentral:ltsc2025"
    }
    elseif ($osVersion.Build -ge 20348) {
        return "mcr.microsoft.com/businesscentral:ltsc2022"
    }
    else {
        return "mcr.microsoft.com/businesscentral:ltsc2019"
    }
}

function Remove-ExistingContainer {
    param([string]$Name)

    $existing = docker ps -a --filter "name=^${Name}$" --format "{{.Names}}" 2>$null
    if ($existing) {
        Write-Log "Removing existing container: $Name" -Level WARN
        docker rm -f $Name 2>$null | Out-Null
        Start-Sleep -Seconds 2
    }
}

function New-ContainerDirectories {
    param([string]$ContainerName)

    $myPath = Join-Path $bcContainerHelperPath "Extensions\$ContainerName\my"

    if (-not (Test-Path $myPath)) {
        New-Item -ItemType Directory -Path $myPath -Force | Out-Null
    }

    return $myPath
}

function New-BCContainerDirect {
    param(
        [string]$ContainerName,
        [string]$ArtifactUrl,
        [string]$FullVersion,
        [hashtable]$Ports,
        [string]$Auth,
        [string]$Username,
        [string]$Password,
        [string]$Isolation,
        [string]$MemoryLimit,
        [string]$Country
    )

    Write-Log "Creating container: $ContainerName"
    Write-Log "Using $Isolation isolation"

    # Get the appropriate image
    $image = Get-BCImageTag -Isolation $Isolation
    Write-Log "Image: $image"

    # Create container directories
    $myPath = New-ContainerDirectories -ContainerName $ContainerName

    # Build docker run arguments
    $dockerArgs = @(
        "run"
        "--detach"
        "--name", $ContainerName
        "--hostname", $ContainerName
        "--isolation", $Isolation
        "--memory", $MemoryLimit
        "--restart", "unless-stopped"

        # Port mappings - map external ports to standard BC container internal ports
        "--publish", "$($Ports.WebPort):80"         # HTTP Web Client (internal 80)
        "--publish", "$($Ports.HttpsPort):443"      # HTTPS Web Client (internal 443)
        "--publish", "$($Ports.DevPort):7049"       # File Share (internal 7049)
        "--publish", "$($Ports.DevServices):7048"   # Developer Services (internal 7048)
        "--publish", "$($Ports.SoapPort):7045"      # Management/SOAP (internal 7045)
        "--publish", "$($Ports.ODataPort):7046"     # Client Services/OData (internal 7046)

        # Expose WinRM for management
        "--expose", "5986"

        # Volume mounts
        "--volume", "c:\bcartifacts.cache:c:\dl"
        "--volume", "${bcContainerHelperPath}:${bcContainerHelperPath}"
        "--volume", "${myPath}:C:\Run\my"
        "--volume", "c:\windows\system32\drivers\etc:C:\driversetc"
        "--volume", "C:\BCBackups:C:\BCBackups"

        # Environment variables - Container configuration
        # Use standard internal ports (not external mapped ports)
        "--env", "accept_eula=Y"
        "--env", "accept_outdated=Y"
        "--env", "artifactUrl=$ArtifactUrl"
        "--env", "WebClientPort=80"
        "--env", "FileSharePort=7049"
        "--env", "ManagementServicesPort=7045"
        "--env", "ClientServicesPort=7046"
        "--env", "DeveloperServicesPort=7048"
        "--env", "auth=$Auth"
        "--env", "username=$Username"
        "--env", "locale=en-US"
        "--env", "multitenant=N"
        "--env", "isBcSandbox=Y"
        "--env", "enableApiServices=Y"
        "--env", "useSSL=N"
        "--env", "ExitOnError=N"
        "--env", "filesOnly=False"
        "--env", "customNavSettings=EnableTaskScheduler=True"

        # Labels
        "--label", "nav="
        "--label", "country=$Country"
    )

    # Add version labels if we have version info
    if ($FullVersion) {
        $dockerArgs += "--label", "version=$FullVersion"
    }

    # Add password for NavUserPassword auth
    if ($Auth -eq 'NavUserPassword' -and $Password) {
        # Write password to file (simpler than securePassword mechanism)
        $passwordFilePath = Join-Path $myPath "password.txt"
        [System.IO.File]::WriteAllText($passwordFilePath, $Password)

        $dockerArgs += "--env", "passwordFile=c:\run\my\password.txt"
        $dockerArgs += "--env", "removePasswordFile=Y"
    }

    # Add the image
    $dockerArgs += $image

    # Execute docker run
    Write-Log "Starting container..."
    $containerId = & docker @dockerArgs 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create container: $containerId"
    }

    Write-Log "Container created with ID: $($containerId.Substring(0, 12))" -Level SUCCESS

    return $containerId
}

function Wait-ContainerHealthy {
    param(
        [string]$ContainerName,
        [int]$TimeoutMinutes = 10
    )

    Write-Log "Waiting for container to become healthy (timeout: $TimeoutMinutes minutes)..."

    $startTime = Get-Date
    $timeout = New-TimeSpan -Minutes $TimeoutMinutes
    $unhealthyCount = 0
    $maxUnhealthyChecks = 60  # Allow 5 minutes of unhealthy (BC Service Tier can take several minutes to start)

    while ((Get-Date) - $startTime -lt $timeout) {
        $status = docker inspect --format '{{.State.Health.Status}}' $ContainerName 2>$null

        if ($status -eq 'healthy') {
            Write-Host ""
            Write-Log "Container is healthy!" -Level SUCCESS
            return $true
        }
        elseif ($status -eq 'unhealthy') {
            $unhealthyCount++
            # Only fail after sustained unhealthy status (BC containers can recover)
            if ($unhealthyCount -ge $maxUnhealthyChecks) {
                Write-Host ""
                Write-Log "Container remained unhealthy after multiple checks" -Level ERROR
                # Get logs for debugging
                $logs = docker logs --tail 50 $ContainerName 2>&1
                Write-Log "Last 50 log lines:`n$logs" -Level ERROR
                return $false
            }
        }
        else {
            # Reset counter if status changes back to starting/none
            $unhealthyCount = 0
        }

        # Show progress
        $elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds)
        Write-Host "`r  Status: $status (${elapsed}s elapsed)..." -NoNewline

        Start-Sleep -Seconds 5
    }

    Write-Host ""
    Write-Log "Timeout waiting for container to become healthy" -Level ERROR
    return $false
}

function New-BackupScheduledTask {
    param(
        [string]$ContainerName,
        [string]$BackupPath,
        [string]$ScriptsPath,
        [int]$RetentionDays,
        [string]$TriggerTime
    )

    Write-Log "Setting up automated backup for $ContainerName..."

    # Create directories
    if (-not (Test-Path $BackupPath)) {
        New-Item -ItemType Directory -Path $BackupPath -Force | Out-Null
    }
    if (-not (Test-Path $ScriptsPath)) {
        New-Item -ItemType Directory -Path $ScriptsPath -Force | Out-Null
    }

    # Create backup script
    $backupScriptPath = Join-Path $ScriptsPath "Backup-$ContainerName.ps1"
    $backupScript = @"

`$ErrorActionPreference = 'Stop'
`$containerName = '$ContainerName'
`$backupPath = '$BackupPath'
`$retentionDays = $RetentionDays
`$logFile = Join-Path `$backupPath 'backup_log.txt'

function Write-BackupLog {
    param([string]`$Message)
    `$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path `$logFile -Value "`$timestamp - `$Message"
}

try {
    # Check if container exists and is running
    `$container = docker ps -a --filter "name=`$containerName" --format "{{.Names}}"
    if (-not `$container) {
        Write-BackupLog "Container `$containerName not found - skipping backup"
        exit 0
    }

    # Start container if stopped
    `$running = docker ps --filter "name=`$containerName" --format "{{.Names}}"
    if (-not `$running) {
        Write-BackupLog "Starting container `$containerName for backup..."
        docker start `$containerName
        Start-Sleep -Seconds 30
    }

    `$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'

    # Execute backup inside container
    docker exec `$containerName powershell -Command "Backup-NavContainerDatabases -containerName `$containerName -bakFolder 'c:\run\my'"

    # Copy backup files from container
    `$containerBackupPath = "c:\run\my"
    docker cp "`${containerName}:`${containerBackupPath}" `$backupPath

    Write-BackupLog "Backup successful"

    # Cleanup old backups
    Get-ChildItem `$backupPath -Filter '*.bak' -Recurse |
        Where-Object { `$_.LastWriteTime -lt (Get-Date).AddDays(-`$retentionDays) } |
        ForEach-Object {
            Remove-Item `$_.FullName -Force
            Write-BackupLog "Removed old backup: `$(`$_.Name)"
        }

} catch {
    Write-BackupLog "Backup FAILED: `$(`$_.Exception.Message)"
    exit 1
}
"@

    $backupScript | Out-File -FilePath $backupScriptPath -Encoding UTF8 -Force
    Write-Log "Backup script created: $backupScriptPath"

    # Create scheduled task
    $taskName = "BC Container Backup - $ContainerName"

    # Remove existing task if present
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }

    $action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-ExecutionPolicy Bypass -NoProfile -File `"$backupScriptPath`""
    $trigger = New-ScheduledTaskTrigger -Daily -At $TriggerTime
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Daily BC container database backup" | Out-Null

    Write-Log "Scheduled task created: $taskName (daily at $TriggerTime)" -Level SUCCESS
}

function Show-DeploymentSummary {
    param(
        [string]$ContainerName,
        [hashtable]$Ports,
        [string]$BackupPath
    )

    Write-Host ""
    Write-Host "====== Deployment Complete ======" -ForegroundColor Green
    Write-Host ""
    Write-Host "Container Name: $ContainerName" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Access URLs:" -ForegroundColor Yellow
    Write-Host "  Web Client:    http://localhost:$($Ports.WebPort)/BC/"
    Write-Host "  HTTPS:         https://localhost:$($Ports.HttpsPort)/BC/"
    Write-Host "  Dev Services:  $($Ports.DevServices) (AL Language extension port)"
    Write-Host "  File Share:    $($Ports.DevPort)"
    Write-Host "  SOAP/Mgmt:     $($Ports.SoapPort)"
    Write-Host "  OData:         $($Ports.ODataPort)"
    Write-Host ""

    if ($EnableScheduledBackups) {
        Write-Host "Backup Configuration:" -ForegroundColor Yellow
        Write-Host "  Backup Path: $BackupPath"
        Write-Host "  Schedule:    Daily at $backupTime"
        Write-Host "  Retention:   $backupRetentionDays days"
        Write-Host ""
    }

    Write-Host "Docker Commands:" -ForegroundColor Yellow
    Write-Host "  Logs:    docker logs $ContainerName"
    Write-Host "  Stop:    docker stop $ContainerName"
    Write-Host "  Start:   docker start $ContainerName"
    Write-Host "  Remove:  docker rm -f $ContainerName"
    Write-Host ""
}
#endregion

#region Main Script
try {
    Write-Log "====== BC Container Deployment (Docker-Direct) v$scriptVersion ======"
    Write-Log "Container: $ContainerName"
    Write-Log "Version: $Version"
    Write-Log "Isolation: $Isolation"

    # Consume -PasswordFile if supplied. The file is written mode-600 by the app
    # and must not outlive this read, so delete it whether or not the read throws.
    if ($PasswordFile) {
        if (-not (Test-Path -LiteralPath $PasswordFile -PathType Leaf)) {
            throw "PasswordFile not found: $PasswordFile"
        }
        try {
            # Strip only a single trailing newline; a password may legitimately
            # contain other whitespace, so Trim() would corrupt it.
            $Password = [System.IO.File]::ReadAllText($PasswordFile) -replace '\r?\n$', ''
        }
        finally {
            Remove-Item -LiteralPath $PasswordFile -Force -ErrorAction SilentlyContinue
        }
        if (-not $Password) {
            throw "PasswordFile was empty: $PasswordFile"
        }
    }

    # Validate password for NavUserPassword auth
    if ($Auth -eq 'NavUserPassword' -and -not $Password) {
        throw "Password is required for NavUserPassword authentication"
    }

    # Step 1: Prerequisites
    Test-Prerequisites | Out-Null

    # Step 2: Get ports
    $ports = Get-VersionPorts -Version $Version
    Write-Log "Ports: Web=$($ports.WebPort), HTTPS=$($ports.HttpsPort), Dev=$($ports.DevServices)"

    # Step 3: Get artifact info
    $artifactInfo = Get-ArtifactInfo -Version $Version -Country $Country

    # Step 4: Remove existing container
    Remove-ExistingContainer -Name $ContainerName

    # Step 5: Create container
    Write-Host ""
    Write-Host "====== Creating Container ======" -ForegroundColor Cyan

    $containerId = New-BCContainerDirect `
        -ContainerName $ContainerName `
        -ArtifactUrl $artifactInfo.ArtifactUrl `
        -FullVersion $artifactInfo.FullVersion `
        -Ports $ports `
        -Auth $Auth `
        -Username $Username `
        -Password $Password `
        -Isolation $Isolation `
        -MemoryLimit $MemoryLimit `
        -Country $Country

    # Step 6: Wait for container to be healthy
    # Increased to 20 minutes for first-time deployments (artifact download + database setup)
    $healthy = Wait-ContainerHealthy -ContainerName $ContainerName -TimeoutMinutes 20

    if (-not $healthy) {
        throw "Container failed to become healthy within timeout period"
    }

    # Step 7: Setup backups if requested
    if ($EnableScheduledBackups) {
        $backupPath = Join-Path $backupRootPath $ContainerName
        New-BackupScheduledTask `
            -ContainerName $ContainerName `
            -BackupPath $backupPath `
            -ScriptsPath $scriptsPath `
            -RetentionDays $backupRetentionDays `
            -TriggerTime $backupTime
    }

    # Step 8: Show summary
    Show-DeploymentSummary -ContainerName $ContainerName -Ports $ports -BackupPath (Join-Path $backupRootPath $ContainerName)

    Write-Log "Container deployment completed successfully!" -Level SUCCESS
    exit 0
}
catch {
    Write-Log "Deployment failed: $($_.Exception.Message)" -Level ERROR
    Write-Log "Stack trace: $($_.ScriptStackTrace)" -Level ERROR
    exit 1
}
#endregion
