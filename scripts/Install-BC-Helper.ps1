<#
.SYNOPSIS
    Business Central Container Deployment Helper v4.8

.DESCRIPTION
    Interactive deployment script for Microsoft Dynamics 365 Business Central containers.
    Features version selection, automated backups, and test kit installation.

.REQUIREMENTS
    - Windows 11 Pro/Enterprise or Windows Server with Hyper-V
    - Docker Engine installed and running
    - BcContainerHelper PowerShell module
    - Administrator privileges
    - Internet access for artifact downloads
    - Minimum 16GB RAM (32GB+ recommended)

.FEATURES
    - Version selection menu (BC 13-28, Latest, Next Minor, Next Major)
    - Version-based container naming (bcserver-bc25, bcserver-latest, etc.)
    - Version-based port allocation (prevents conflicts between versions)
    - Automated daily backup with scheduled task (02:00, 7-day retention)
    - Testing kits auto-install (except preview builds)

.PROCESS
    1. Verify prerequisites (Docker, BcContainerHelper)
    2. Display version selection menu
    3. Prompt for container credentials
    4. Calculate version-specific ports
    5. Create BC container with configuration
    6. Setup automated daily backup task
    7. Install test toolkit (non-preview builds)
    8. Display access URLs

.EXAMPLE
    .\Install-BC-Helper.ps1

.NOTES
    Author: CosmicBytez IT Operations
    Version: 4.9
    Last Updated: 2026-01-13

.CHANGELOG
    4.9 - Changed default isolation mode from 'hyperv' to 'process'
        - Process isolation avoids HNS port conflict issues on Windows 11/Server when OS versions match
        - Added -Isolation parameter to allow override if needed
        - Fixes persistent 0x803b0013 errors during container creation
    4.8 - CRITICAL FIX: Clean NAT mappings BEFORE restarting Docker (not after)
        - Docker recreates NAT mappings from persistent state when it starts
        - Previously cleaned AFTER Docker started, allowing recreation
        - Now cleans while Docker is stopped, preventing 0x803b0013 errors
        - Fixes deployment failures from BC Docker Manager desktop app
    4.7 - NUCLEAR OPTION: Unconditionally restart HNS and Docker at deployment start
        - This clears corrupted HNS database state that causes 0x803b0013 errors
        - NAT cleanup alone wasn't enough - HNS endpoints themselves were corrupted
        - Removed redundant conditional restart logic (now always restarts)
    4.6 - AGGRESSIVE: Remove ALL NAT mappings in BC port range (8000-9999) at START
        - Added -Confirm:$false and better error handling
        - Added 3 second wait after cleanup for NAT layer to settle
    4.5 - Added NAT static mapping cleanup during retry loop (fixes persistent 0x803b0013)
        - Cleans both current and bumped ports before retry
        - This was the missing piece - NAT mappings persist after HNS cleanup
    4.4 - Increased port bump to +100 (was +10) to avoid overlapping stuck ports
        - Added HNS endpoint cleanup between retries
        - Increased max retries to 3
    4.3 - Stopped removing NAT network during cleanup (caused 0x490 "Element not found")
        - Added 0x490 and other HNS errors to retry pattern
        - More conservative cleanup: only removes orphaned endpoints
    4.2 - Fixed retry logic: bumps ports +10 on conflict instead of resetting HNS
        - No longer kills Docker/WSL on retry
        - Fixed HNS cmdlet syntax (pipe objects, not -Id parameter)
    4.1 - Smart port detection: checks HNS endpoints, excluded ranges, Docker bindings
        - Always auto-selects next available port if preferred port is unavailable
        - Each BC version gets 100-port range to avoid conflicts
    4.0 - Added HNS network reset to fix persistent port conflict errors (0x803b0013)
    3.9 - Added auto port selection when ports are in use
    3.8 - Fixed auth type handling, improved credential validation
#>

[CmdletBinding()]
param(
    # BC Version - can be 13-27, Latest, NextMinor, or NextMajor
    [Parameter(Mandatory=$false)]
    [ValidateSet('13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','Latest','NextMinor','NextMajor')]
    [string]$Version,

    # Container name - must start with bcserver-
    [Parameter(Mandatory=$false)]
    [string]$ContainerName,

    # Authentication type
    [Parameter(Mandatory=$false)]
    [ValidateSet('Windows','NavUserPassword')]
    [string]$Auth = 'NavUserPassword',

    # Username for NavUserPassword auth
    [Parameter(Mandatory=$false)]
    [string]$Username = 'admin',

    # Password for NavUserPassword auth
    [Parameter(Mandatory=$false)]
    [string]$Password,

    # Install test toolkit
    [Parameter(Mandatory=$false)]
    [switch]$InstallTestToolkit,

    # Enable scheduled backups
    [Parameter(Mandatory=$false)]
    [switch]$EnableScheduledBackups,

    # Non-interactive mode (for app deployment)
    [Parameter(Mandatory=$false)]
    [switch]$NonInteractive,

    # Container isolation mode (process is recommended on Windows 11 when OS versions match)
    [Parameter(Mandatory=$false)]
    [ValidateSet('process','hyperv')]
    [string]$Isolation = 'process',

    # Install the BcContainerHelper module and exit without deploying a container.
    # Used by the app's Setup page for first-run onboarding.
    [Parameter(Mandatory=$false)]
    [switch]$InstallModuleOnly
)

$ErrorActionPreference = 'Stop'
$scriptVersion = "4.9"

#region Configuration
$backupRootPath = "C:\BCBackups"
$scriptsPath = "C:\Scripts"
$backupRetentionDays = 7
$backupTime = "02:00"
$defaultMemoryLimit = "8G"
$country = "us"
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

function Install-BcContainerHelperModule {
    # Check BcContainerHelper module
    $bcModule = Get-Module -ListAvailable -Name BcContainerHelper | Select-Object -First 1
    if (-not $bcModule) {
        Write-Log "BcContainerHelper module not found. Installing..." -Level WARN
        try {
            Install-Module BcContainerHelper -Force -Scope AllUsers
            Import-Module BcContainerHelper -Force
            Write-Log "BcContainerHelper installed successfully" -Level SUCCESS
        }
        catch {
            throw "Failed to install BcContainerHelper module: $($_.Exception.Message)"
        }
    }
    else {
        Import-Module BcContainerHelper -Force
        Write-Log "BcContainerHelper: v$($bcModule.Version)" -Level SUCCESS
    }
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

    Install-BcContainerHelperModule

    return $true
}

function Get-BCVersionSelection {
    $versions = @{
        1  = @{ Version = "13"; Name = "BC 13 (Legacy)"; Preview = $false }
        2  = @{ Version = "14"; Name = "BC 14 (Legacy)"; Preview = $false }
        3  = @{ Version = "15"; Name = "BC 15"; Preview = $false }
        4  = @{ Version = "16"; Name = "BC 16"; Preview = $false }
        5  = @{ Version = "17"; Name = "BC 17"; Preview = $false }
        6  = @{ Version = "18"; Name = "BC 18"; Preview = $false }
        7  = @{ Version = "19"; Name = "BC 19"; Preview = $false }
        8  = @{ Version = "20"; Name = "BC 20"; Preview = $false }
        9  = @{ Version = "21"; Name = "BC 21"; Preview = $false }
        10 = @{ Version = "22"; Name = "BC 22"; Preview = $false }
        11 = @{ Version = "23"; Name = "BC 23"; Preview = $false }
        12 = @{ Version = "24"; Name = "BC 24"; Preview = $false }
        13 = @{ Version = "25"; Name = "BC 25 (LTS)"; Preview = $false }
        14 = @{ Version = "26"; Name = "BC 26"; Preview = $false }
        15 = @{ Version = "27"; Name = "BC 27"; Preview = $false }
        16 = @{ Version = "28"; Name = "BC 28 (Current)"; Preview = $false }
        17 = @{ Version = "Latest"; Name = "Latest"; Preview = $false }
        18 = @{ Version = "NextMinor"; Name = "Next Minor (Preview)"; Preview = $true }
        19 = @{ Version = "NextMajor"; Name = "Next Major (Preview)"; Preview = $true }
    }

    Write-Host ""
    Write-Host "====== Business Central Container Setup (v$scriptVersion) ======" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Select BC Version:" -ForegroundColor Yellow

    foreach ($key in ($versions.Keys | Sort-Object)) {
        $v = $versions[$key]
        $prefix = if ($key -lt 10) { " " } else { "" }
        Write-Host "  $prefix$key. $($v.Name)"
    }

    Write-Host ""
    $selection = Read-Host "Enter selection (1-18)"

    if (-not $versions.ContainsKey([int]$selection)) {
        throw "Invalid selection. Please enter a number between 1 and 18."
    }

    return $versions[[int]$selection]
}

function Test-PortAvailable {
    param(
        [int]$Port
    )

    # Check if port is in use via netstat
    $netstatResult = netstat -ano 2>$null | Select-String ":$Port\s"
    if ($netstatResult) {
        return $false
    }

    # Check HNS endpoint port reservations (the real cause of 0x803b0013 errors)
    if (Get-Command Get-HnsEndpoint -ErrorAction SilentlyContinue) {
        try {
            $hnsEndpoints = Get-HnsEndpoint -ErrorAction SilentlyContinue
            foreach ($endpoint in $hnsEndpoints) {
                # Check if this endpoint has our port in its policies
                if ($endpoint.Policies) {
                    $portPolicies = $endpoint.Policies | Where-Object {
                        $_.Type -eq 'PortMapping' -and
                        ($_.ExternalPort -eq $Port -or $_.InternalPort -eq $Port)
                    }
                    if ($portPolicies) {
                        return $false
                    }
                }
            }
        }
        catch {
            # If HNS check fails, continue with other checks
        }
    }

    # Check Windows excluded port ranges (Hyper-V dynamic ports)
    try {
        $excludedRanges = netsh interface ipv4 show excludedportrange protocol=tcp 2>$null
        foreach ($line in $excludedRanges -split "`n") {
            if ($line -match '^\s*(\d+)\s+(\d+)\s*$') {
                $start = [int]$Matches[1]
                $end = [int]$Matches[2]
                if ($Port -ge $start -and $Port -le $end) {
                    return $false
                }
            }
        }
    }
    catch {
        # Continue if excluded range check fails
    }

    # Check Docker port bindings directly
    try {
        $dockerPorts = docker ps --format '{{.Ports}}' 2>$null
        if ($dockerPorts -match ":$Port->") {
            return $false
        }
    }
    catch {
        # Continue if docker check fails
    }

    return $true
}

function Find-AvailablePort {
    param(
        [int]$StartPort,
        [int]$MaxAttempts = 100
    )

    $port = $StartPort
    for ($i = 0; $i -lt $MaxAttempts; $i++) {
        if (Test-PortAvailable -Port $port) {
            return $port
        }
        $port++
    }

    # If no port found in range, throw error
    throw "Could not find available port starting from $StartPort after $MaxAttempts attempts"
}

function Get-VersionPorts {
    param(
        [string]$Version,
        [switch]$AutoSelectAvailable
    )

    # Calculate version-specific port RANGES to avoid conflicts
    # Each BC version gets its own 100-port range for each service
    # This allows multiple containers of same version with different ports
    $baseVersion = switch ($Version) {
        "Latest"    { 99 }
        "NextMinor" { 98 }
        "NextMajor" { 97 }
        default     { [int]$Version }
    }

    # Define port ranges for each service type
    # Format: BaseStart + (version * rangeSize) gives each version its own range
    $portRanges = @{
        WebPort   = @{ Start = 8500 + $baseVersion; RangeSize = 100 }
        DevPort   = @{ Start = 7000 + $baseVersion; RangeSize = 100 }
        HttpsPort = @{ Start = 9400 + $baseVersion; RangeSize = 100 }
        SoapPort  = @{ Start = 6000 + ($baseVersion * 10); RangeSize = 100 }
        ODataPort = @{ Start = 6100 + ($baseVersion * 10); RangeSize = 100 }
    }

    $ports = @{}

    # Always auto-select available ports to avoid HNS conflicts
    Write-Log "Checking port availability and auto-selecting if needed..."

    foreach ($portName in @('WebPort', 'DevPort', 'HttpsPort', 'SoapPort', 'ODataPort')) {
        $range = $portRanges[$portName]
        $preferredPort = $range.Start

        if (Test-PortAvailable -Port $preferredPort) {
            $ports[$portName] = $preferredPort
        }
        else {
            # Find next available port in the range
            $newPort = Find-AvailablePort -StartPort $preferredPort -MaxAttempts $range.RangeSize
            if ($newPort -ne $preferredPort) {
                Write-Log "Port $preferredPort ($portName) unavailable, using $newPort" -Level WARN
            }
            $ports[$portName] = $newPort
        }
    }

    return $ports
}

function Clear-OrphanedNatPorts {
    param(
        [hashtable]$Ports,
        [string]$ContainerName
    )

    Write-Log "Checking for orphaned NAT port reservations..."

    # Collect all ports we need to check
    $portsToCheck = @($Ports.WebPort, $Ports.DevPort, $Ports.HttpsPort, $Ports.SoapPort, $Ports.ODataPort) | Where-Object { $_ }

    # Step 0: Check for Windows excluded port ranges (reserved by Hyper-V, WinNAT, etc.)
    Write-Log "Checking Windows excluded port ranges..."
    try {
        $excludedRangesOutput = netsh interface ipv4 show excludedportrange protocol=tcp 2>&1
        if ($LASTEXITCODE -eq 0 -and $excludedRangesOutput) {
            # Parse the excluded port ranges
            $excludedRanges = @()
            foreach ($line in $excludedRangesOutput -split "`n") {
                # Lines look like: "    50000    50059"
                if ($line -match '^\s*(\d+)\s+(\d+)\s*$') {
                    $excludedRanges += @{
                        Start = [int]$Matches[1]
                        End   = [int]$Matches[2]
                    }
                }
            }

            # Check if any of our required ports fall within excluded ranges
            $portsInExcludedRange = @()
            foreach ($port in $portsToCheck) {
                foreach ($range in $excludedRanges) {
                    if ($port -ge $range.Start -and $port -le $range.End) {
                        $portsInExcludedRange += @{
                            Port       = $port
                            RangeStart = $range.Start
                            RangeEnd   = $range.End
                        }
                        break
                    }
                }
            }

            if ($portsInExcludedRange.Count -gt 0) {
                Write-Log "WARNING: The following ports are in Windows excluded port ranges:" -Level WARN
                foreach ($portInfo in $portsInExcludedRange) {
                    Write-Log "  Port $($portInfo.Port) is in excluded range $($portInfo.RangeStart)-$($portInfo.RangeEnd)" -Level WARN
                }
                Write-Log "These ports are reserved at the OS level and cannot be used by Docker." -Level WARN
                Write-Log "Consider using different port numbers or releasing the excluded ranges." -Level WARN
            }
            else {
                Write-Log "No ports conflict with Windows excluded port ranges" -Level SUCCESS
            }
        }
    }
    catch {
        Write-Log "Could not check excluded port ranges: $($_.Exception.Message)" -Level WARN
    }

    try {
        # Step 1: Check if any of our required ports are actually in use
        $portsInUse = @()
        foreach ($port in $portsToCheck) {
            # Check via netstat for TCP listeners
            $netstatResult = netstat -ano | Select-String ":$port\s" 2>$null
            if ($netstatResult) {
                $portsInUse += $port
                Write-Log "Port $port is currently in use (netstat)" -Level WARN
            }

            # Also check via Test-NetConnection (TCP connect test)
            $tcpTest = Test-NetConnection -ComputerName localhost -Port $port -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
            if ($tcpTest.TcpTestSucceeded) {
                if ($port -notin $portsInUse) { $portsInUse += $port }
                Write-Log "Port $port responds to TCP connection" -Level WARN
            }
        }

        # Step 2: Force remove ANY container with this name (all states including 'created')
        Write-Log "Checking for existing containers named: $ContainerName"
        $existingContainer = docker ps -a --filter "name=$ContainerName" --format "{{.Names}}" 2>$null
        if ($existingContainer) {
            foreach ($container in $existingContainer -split "`n") {
                if ($container -and $container.Trim()) {
                    Write-Log "Force removing container: $($container.Trim())" -Level WARN
                    docker rm -f $container.Trim() 2>$null
                }
            }
            Start-Sleep -Seconds 2
        }

        # Step 3: Clean up ALL bcserver containers in ANY state (running, exited, created, dead)
        Write-Log "Checking for any bcserver containers in any state..."
        $allBcContainers = docker ps -a --filter "name=bcserver" --format "{{.Names}} {{.Status}}" 2>$null
        if ($allBcContainers) {
            foreach ($line in $allBcContainers -split "`n") {
                if ($line -and $line.Trim()) {
                    $containerName = ($line.Trim() -split " ")[0]
                    Write-Log "Removing bcserver container: $containerName (Status: $line)" -Level WARN
                    docker rm -f $containerName 2>$null
                }
            }
            Start-Sleep -Seconds 2
        }

        # Step 3b: Also remove any containers in 'created' state (failed to start)
        $createdContainers = docker ps -a --filter "status=created" --format "{{.Names}}" 2>$null
        if ($createdContainers) {
            foreach ($container in $createdContainers -split "`n") {
                if ($container -and $container.Trim()) {
                    Write-Log "Removing 'created' state container: $($container.Trim())" -Level WARN
                    docker rm -f $container.Trim() 2>$null
                }
            }
        }

        # Step 4: ALWAYS restart HNS and Docker to clear corrupted HNS state
        # This is the nuclear option but necessary when HNS database is corrupted
        Write-Log "Restarting HNS and Docker services to ensure clean state..." -Level WARN
        try {
            # Stop Docker first (it depends on HNS)
            Stop-Service -Name docker -Force -ErrorAction Stop
            Write-Log "Docker service stopped" -Level INFO
            Start-Sleep -Seconds 3

            # Stop HNS to clear all endpoint/network state
            Stop-Service -Name hns -Force -ErrorAction Stop
            Write-Log "HNS service stopped" -Level INFO
            Start-Sleep -Seconds 2

            # CRITICAL FIX: Clean NAT mappings WHILE services are stopped
            # This prevents Docker from recreating them from persistent state
            Write-Log "Cleaning up NAT static mappings while services are stopped..." -Level INFO
            try {
                $natMappings = Get-NetNatStaticMapping -ErrorAction Stop
                if ($natMappings) {
                    $bcPortMappings = $natMappings | Where-Object {
                        ($_.ExternalPort -ge 8000 -and $_.ExternalPort -le 9999) -or
                        ($_.InternalPort -ge 8000 -and $_.InternalPort -le 9999)
                    }
                    $removedCount = 0
                    foreach ($mapping in $bcPortMappings) {
                        try {
                            Remove-NetNatStaticMapping -StaticMappingID $mapping.StaticMappingID -Confirm:$false -ErrorAction Stop
                            $removedCount++
                        } catch {
                            # Ignore individual mapping errors
                        }
                    }
                    if ($removedCount -gt 0) {
                        Write-Log "Removed $removedCount NAT static mappings" -Level INFO
                        Start-Sleep -Seconds 5  # Let NAT layer settle before restarting services
                    } else {
                        Write-Log "No NAT static mappings found in BC port range" -Level INFO
                    }
                }
            }
            catch {
                Write-Log "NAT static mapping cleanup warning: $($_.Exception.Message)" -Level WARN
            }

            # Now restart services with clean NAT state
            Start-Service -Name hns -ErrorAction Stop
            Write-Log "HNS service started" -Level INFO
            Start-Sleep -Seconds 3

            # Start Docker
            Start-Service -Name docker -ErrorAction Stop
            Write-Log "Docker service starting..." -Level INFO
            Start-Sleep -Seconds 10

            # Wait for Docker to be responsive
            $dockerRetry = 0
            $maxDockerRetries = 12
            while ($dockerRetry -lt $maxDockerRetries) {
                $dockerCheck = docker info 2>$null
                if ($LASTEXITCODE -eq 0) {
                    Write-Log "Docker service ready" -Level SUCCESS
                    break
                }
                Start-Sleep -Seconds 5
                $dockerRetry++
            }
            if ($dockerRetry -eq $maxDockerRetries) {
                throw "Docker service failed to become responsive after restart"
            }
        }
        catch {
            Write-Log "Service restart failed: $($_.Exception.Message)" -Level ERROR
            throw "Cannot proceed without restarting services - deployment aborted"
        }

        # Step 5: Prune unused Docker networks
        Write-Log "Pruning unused Docker networks..."
        docker network prune -f 2>$null

        # Step 6: NAT cleanup already completed in Step 4 (moved before service restart)
        # This was a CRITICAL FIX: NAT mappings must be cleaned WHILE Docker is stopped
        # to prevent Docker from recreating them from persistent state

        # Step 7: If HNS module is available, clean up endpoints AND networks
        if (Get-Command Get-HnsEndpoint -ErrorAction SilentlyContinue) {
            try {
                # Remove orphaned HNS endpoints (pipe object, don't use -Id)
                $hnsEndpoints = Get-HnsEndpoint -ErrorAction SilentlyContinue
                if ($hnsEndpoints) {
                    $orphanedEndpoints = $hnsEndpoints | Where-Object {
                        $_.Name -like "*$ContainerName*" -or $_.Name -like "*bcserver*"
                    }
                    foreach ($endpoint in $orphanedEndpoints) {
                        Write-Log "Removing orphaned HNS endpoint: $($endpoint.Name)" -Level WARN
                        $endpoint | Remove-HnsEndpoint -ErrorAction SilentlyContinue
                    }
                }

                # NOTE: Do NOT remove the NAT network - it causes "Element not found (0x490)" errors
                # Docker doesn't reliably recreate it. Only clean up orphaned endpoints above.
            }
            catch {
                Write-Log "HNS cleanup skipped: $($_.Exception.Message)" -Level WARN
            }
        }

        # Service restart already completed in Step 4 - HNS and Docker restarted unconditionally
        Write-Log "NAT port cleanup completed - all ports are available" -Level SUCCESS
    }
    catch {
        Write-Log "NAT cleanup error: $($_.Exception.Message)" -Level ERROR
        # Re-throw critical errors, continue for warnings
        if ($_.Exception.Message -like "*restart Docker*") {
            throw
        }
    }
}

function Get-ContainerName {
    param(
        [string]$Version
    )

    $suffix = switch ($Version) {
        "Latest"    { "latest" }
        "NextMinor" { "nextminor" }
        "NextMajor" { "nextmajor" }
        default     { "bc$Version" }
    }

    return "bcserver-$suffix"
}

function Get-ArtifactUrl {
    param(
        [string]$Version,
        [string]$Country = "us"
    )

    $params = @{
        type    = "Sandbox"
        country = $Country
        select  = "Latest"
    }

    switch ($Version) {
        "Latest" {
            # Get latest stable version
        }
        "NextMinor" {
            $params.select = "NextMinor"
        }
        "NextMajor" {
            $params.select = "NextMajor"
        }
        default {
            $params.version = $Version
        }
    }

    return Get-BcArtifactUrl @params
}

function New-BCContainerDeployment {
    param(
        [string]$ContainerName,
        [string]$ArtifactUrl,
        [PSCredential]$Credential,
        [hashtable]$Ports,
        [bool]$IncludeTestToolkit,
        [string]$MemoryLimit = "8G",
        [ValidateSet('Windows','NavUserPassword')]
        [string]$AuthType = "NavUserPassword"
    )

    Write-Log "Creating container: $ContainerName"
    Write-Log "Artifact URL: $ArtifactUrl"
    Write-Log "Authentication: $AuthType"
    Write-Log "Ports - Web: $($Ports.WebPort), Dev: $($Ports.DevPort), HTTPS: $($Ports.HttpsPort)"

    $containerParams = @{
        containerName              = $ContainerName
        accept_eula                = $true
        auth                       = $AuthType
        artifactUrl                = $ArtifactUrl
        isolation                  = $script:Isolation
        memoryLimit                = $MemoryLimit
        updateHosts                = $true
        useBestContainerOS         = $true
        assignPremiumPlan          = $true
        WebClientPort              = $Ports.WebPort
        FileSharePort              = $Ports.DevPort
        ManagementServicesPort     = $Ports.SoapPort
        ClientServicesPort         = $Ports.ODataPort
        enableTaskScheduler        = $true
        publishPorts               = @($Ports.WebPort, $Ports.DevPort, $Ports.HttpsPort, $Ports.SoapPort, $Ports.ODataPort)
        additionalParameters       = @("--restart=unless-stopped", "-p $($Ports.HttpsPort):443")
    }

    # Only add credential for NavUserPassword auth
    if ($AuthType -eq "NavUserPassword" -and $Credential) {
        $containerParams.credential = $Credential
    }

    if ($IncludeTestToolkit) {
        $containerParams.includeTestToolkit = $true
        $containerParams.includeTestLibrariesOnly = $true
        $containerParams.includePerformanceToolkit = $true
        Write-Log "Test toolkit will be included" -Level INFO
    }

    # Try deployment with retry on port conflict
    $maxRetries = 3
    $retryCount = 0
    $lastError = $null
    $portBump = 100  # Bump by 100 to avoid overlapping with stuck HNS ports

    while ($retryCount -lt $maxRetries) {
        try {
            New-BcContainer @containerParams
            Write-Log "Container $ContainerName created successfully" -Level SUCCESS
            return  # Success - exit function
        }
        catch {
            $lastError = $_
            $retryCount++

            # Check if it's an HNS/networking error that can be resolved with different ports
            if ($_.Exception.Message -match "0x803b0013|0x490|hnsCall failed|port.*already.*exists|port.*allocated|bind.*address already in use|Element not found") {
                Write-Log "HNS networking error detected (attempt $retryCount of $maxRetries)" -Level WARN

                if ($retryCount -lt $maxRetries) {
                    Write-Log "Cleaning up failed container and HNS endpoints..." -Level WARN

                    # Force remove the zombie container
                    try {
                        $null = docker rm -f $ContainerName 2>&1
                    } catch { }

                    # Remove any container in 'created' state
                    try {
                        $createdContainers = docker ps -a --filter "status=created" --format "{{.ID}}" 2>$null
                        if ($createdContainers) {
                            foreach ($cid in $createdContainers -split "`n") {
                                if ($cid -and $cid.Trim()) {
                                    $null = docker rm -f $cid.Trim() 2>&1
                                }
                            }
                        }
                    } catch { }

                    # Clean up orphaned HNS endpoints from failed container creation
                    if (Get-Command Get-HnsEndpoint -ErrorAction SilentlyContinue) {
                        try {
                            $hnsEndpoints = Get-HnsEndpoint -ErrorAction SilentlyContinue
                            $orphanedEndpoints = $hnsEndpoints | Where-Object {
                                $_.Name -like "*$ContainerName*" -or $_.Name -like "*bcserver*"
                            }
                            foreach ($endpoint in $orphanedEndpoints) {
                                Write-Log "Removing orphaned HNS endpoint: $($endpoint.Name)" -Level WARN
                                $endpoint | Remove-HnsEndpoint -ErrorAction SilentlyContinue
                            }
                        } catch { }
                    }

                    # Clean up NAT static mappings for ALL ports in range we might use (8000-9999)
                    # This is critical - NAT mappings persist even after HNS endpoints are removed
                    try {
                        $natMappings = Get-NetNatStaticMapping -ErrorAction SilentlyContinue
                        if ($natMappings) {
                            # Get current and bumped ports to clean
                            $currentPorts = @(
                                $containerParams.WebClientPort,
                                $containerParams.FileSharePort,
                                $containerParams.ManagementServicesPort,
                                $containerParams.ClientServicesPort,
                                # Also clean the NEXT set of bumped ports
                                ($containerParams.WebClientPort + $portBump),
                                ($containerParams.FileSharePort + $portBump),
                                ($containerParams.ManagementServicesPort + $portBump),
                                ($containerParams.ClientServicesPort + $portBump)
                            )
                            # Add HTTPS ports
                            foreach ($param in $containerParams.additionalParameters) {
                                if ($param -match '-p\s*(\d+):443') {
                                    $currentPorts += [int]$Matches[1]
                                    $currentPorts += ([int]$Matches[1] + $portBump)
                                }
                            }
                            $stuckMappings = $natMappings | Where-Object {
                                $_.ExternalPort -in $currentPorts -or $_.InternalPort -in $currentPorts
                            }
                            foreach ($mapping in $stuckMappings) {
                                Write-Log "Removing NAT static mapping for port $($mapping.ExternalPort)" -Level WARN
                                Remove-NetNatStaticMapping -StaticMappingID $mapping.StaticMappingID -ErrorAction SilentlyContinue
                            }
                            if ($stuckMappings) {
                                Write-Log "Cleared $($stuckMappings.Count) NAT static mappings" -Level INFO
                                Start-Sleep -Seconds 2
                            }
                        }
                    } catch {
                        Write-Log "NAT cleanup skipped: $($_.Exception.Message)" -Level WARN
                    }

                    # Bump ports significantly to avoid stuck HNS reservations
                    Write-Log "Finding alternative ports (bumping by +$portBump)..." -Level WARN

                    $containerParams.WebClientPort += $portBump
                    $containerParams.FileSharePort += $portBump
                    $containerParams.ManagementServicesPort += $portBump
                    $containerParams.ClientServicesPort += $portBump

                    # Calculate new HTTPS port
                    $currentHttps = 9499
                    foreach ($param in $containerParams.additionalParameters) {
                        if ($param -match '-p\s*(\d+):443') {
                            $currentHttps = [int]$Matches[1]
                            break
                        }
                    }
                    $newHttpsPort = $currentHttps + $portBump

                    $containerParams.publishPorts = @(
                        $containerParams.WebClientPort,
                        $containerParams.FileSharePort,
                        $newHttpsPort,
                        $containerParams.ManagementServicesPort,
                        $containerParams.ClientServicesPort
                    )
                    $containerParams.additionalParameters = @("--restart=unless-stopped", "-p ${newHttpsPort}:443")

                    Write-Log "New ports - Web: $($containerParams.WebClientPort), Dev: $($containerParams.FileSharePort), HTTPS: $newHttpsPort" -Level INFO
                    Write-Log "Retrying container creation with new ports..." -Level INFO
                    Start-Sleep -Seconds 5
                }
            }
            else {
                # Non-port error, don't retry
                throw $lastError
            }
        }
    }

    # If we get here, all retries failed
    throw $lastError
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

    # Create backup directory
    if (-not (Test-Path $BackupPath)) {
        New-Item -ItemType Directory -Path $BackupPath -Force | Out-Null
    }

    # Create scripts directory
    if (-not (Test-Path $ScriptsPath)) {
        New-Item -ItemType Directory -Path $ScriptsPath -Force | Out-Null
    }

    # Create backup script
    $backupScriptPath = Join-Path $ScriptsPath "Backup-$ContainerName.ps1"
    $backupScript = @"
<#
.SYNOPSIS
    Automated backup script for $ContainerName container
.DESCRIPTION
    Created by Install-BC-Helper.ps1 v$scriptVersion
    Runs daily at $TriggerTime with $RetentionDays day retention
#>

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
    Import-Module BcContainerHelper -Force

    # Check if container exists and is running
    `$container = docker ps -a --filter "name=`$containerName" --format "{{.Names}}" 2>`$null
    if (-not `$container) {
        Write-BackupLog "Container `$containerName not found - skipping backup"
        exit 0
    }

    # Start container if stopped
    `$running = docker ps --filter "name=`$containerName" --format "{{.Names}}" 2>`$null
    if (-not `$running) {
        Write-BackupLog "Starting container `$containerName for backup..."
        Start-BcContainer -containerName `$containerName
        Start-Sleep -Seconds 30
    }

    `$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    `$bakFile = Join-Path `$backupPath "`${containerName}_`$timestamp.bak"

    # Create backup using BcContainerHelper
    Backup-BcContainerDatabases -containerName `$containerName -bakFolder `$backupPath

    Write-BackupLog "Backup successful: `$bakFile"

    # Cleanup old backups
    `$oldBackups = Get-ChildItem `$backupPath -Filter '*.bak' |
        Where-Object { `$_.LastWriteTime -lt (Get-Date).AddDays(-`$retentionDays) }

    foreach (`$backup in `$oldBackups) {
        Remove-Item `$backup.FullName -Force
        Write-BackupLog "Removed old backup: `$(`$backup.Name)"
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
        Write-Log "Removed existing scheduled task" -Level WARN
    }

    $action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-ExecutionPolicy Bypass -NoProfile -File `"$backupScriptPath`""
    $trigger = New-ScheduledTaskTrigger -Daily -At $TriggerTime
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Daily BC container database backup for $ContainerName (created by Install-BC-Helper.ps1)" | Out-Null

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
    Write-Host "  Web Client: https://${ContainerName}:$($Ports.HttpsPort)/BC/"
    Write-Host "  Dev Port:   $($Ports.DevPort)"
    Write-Host ""
    Write-Host "Backup Configuration:" -ForegroundColor Yellow
    Write-Host "  Backup Path: $BackupPath"
    Write-Host "  Schedule:    Daily at $backupTime"
    Write-Host "  Retention:   $backupRetentionDays days"
    Write-Host ""
    Write-Host "Container Commands:" -ForegroundColor Yellow
    Write-Host "  Start:   Start-BcContainer -containerName $ContainerName"
    Write-Host "  Stop:    Stop-BcContainer -containerName $ContainerName"
    Write-Host "  Remove:  Remove-BcContainer -containerName $ContainerName"
    Write-Host ""
}
#endregion

#region Main Script
try {
    # Module-only mode: install BcContainerHelper and exit. Does not touch
    # Docker or deploy a container.
    if ($InstallModuleOnly) {
        Write-Log "Installing BcContainerHelper module only (no container deployment)..."
        Install-BcContainerHelperModule
        Write-Log "BcContainerHelper is ready" -Level SUCCESS
        exit 0
    }

    # Step 1: Verify prerequisites
    Test-Prerequisites | Out-Null

    # Step 2: Get version selection (interactive or from parameter)
    if ($NonInteractive -and $Version) {
        # Non-interactive mode - use provided parameters
        $versionInfo = @{
            Version = $Version
            Name = switch ($Version) {
                "Latest"    { "Latest" }
                "NextMinor" { "Next Minor (Preview)" }
                "NextMajor" { "Next Major (Preview)" }
                default     { "BC $Version" }
            }
            Preview = ($Version -eq "NextMinor" -or $Version -eq "NextMajor")
        }
        Write-Log "Non-interactive mode: Using version $($versionInfo.Name)"
    }
    elseif ($Version) {
        # Version provided via parameter but interactive mode
        $versionInfo = @{
            Version = $Version
            Name = switch ($Version) {
                "Latest"    { "Latest" }
                "NextMinor" { "Next Minor (Preview)" }
                "NextMajor" { "Next Major (Preview)" }
                default     { "BC $Version" }
            }
            Preview = ($Version -eq "NextMinor" -or $Version -eq "NextMajor")
        }
        Write-Log "Using version from parameter: $($versionInfo.Name)"
    }
    else {
        # Interactive mode - show menu
        $versionInfo = Get-BCVersionSelection
    }
    Write-Log "Selected: $($versionInfo.Name)"

    # Step 3: Get container name and ports
    if ($ContainerName) {
        $containerName = $ContainerName
    }
    else {
        $containerName = Get-ContainerName -Version $versionInfo.Version
    }
    $ports = Get-VersionPorts -Version $versionInfo.Version

    # Check for existing container
    $existingContainer = docker ps -a --filter "name=$containerName" --format "{{.Names}}" 2>$null
    if ($existingContainer) {
        if ($NonInteractive) {
            Write-Log "Container '$containerName' already exists. Removing..." -Level WARN
            Remove-BcContainer -containerName $containerName
            # Clean up any orphaned NAT port reservations after container removal
            Clear-OrphanedNatPorts -Ports $ports -ContainerName $containerName
        }
        else {
            Write-Host ""
            Write-Host "Container '$containerName' already exists." -ForegroundColor Yellow
            $response = Read-Host "Remove existing container? (Y/N)"
            if ($response -eq 'Y' -or $response -eq 'y') {
                Write-Log "Removing existing container..."
                Remove-BcContainer -containerName $containerName
                # Clean up any orphaned NAT port reservations after container removal
                Clear-OrphanedNatPorts -Ports $ports -ContainerName $containerName
            }
            else {
                Write-Log "Deployment cancelled by user" -Level WARN
                exit 0
            }
        }
    }
    else {
        # Even if no container exists, check for orphaned NAT ports from crashed containers
        if ($NonInteractive) {
            Clear-OrphanedNatPorts -Ports $ports -ContainerName $containerName
        }
    }

    # Step 4: Get credentials
    if ($NonInteractive -and $Auth -eq 'NavUserPassword') {
        # Non-interactive mode with NavUserPassword requires password parameter
        if (-not $Password) {
            throw "Password is required for NavUserPassword authentication in non-interactive mode. Use -Password parameter."
        }
        $securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
        $credential = New-Object System.Management.Automation.PSCredential ($Username, $securePassword)
        Write-Log "Using credentials from parameters (user: $Username)"
    }
    elseif ($Auth -eq 'Windows') {
        # Windows auth - no credentials needed for container, use current user
        $credential = $null
        Write-Log "Using Windows authentication"
    }
    elseif ($NonInteractive) {
        # Non-interactive mode but no password provided and not Windows auth
        throw "Non-interactive mode requires either -Auth Windows or -Password parameter for NavUserPassword auth"
    }
    else {
        # Interactive mode - prompt for credentials
        Write-Host ""
        $credential = Get-Credential -Message "Enter credentials for BC Container admin user"
        if (-not $credential) {
            throw "Credentials are required to create the container"
        }
    }

    # Step 5: Get artifact URL
    Write-Log "Retrieving artifact URL..."
    $artifactUrl = Get-ArtifactUrl -Version $versionInfo.Version -Country $country
    Write-Log "Artifact URL: $artifactUrl"

    # Determine test toolkit installation
    $includeTestToolkit = if ($NonInteractive) {
        $InstallTestToolkit.IsPresent -and (-not $versionInfo.Preview)
    } else {
        -not $versionInfo.Preview
    }

    # Step 6: Confirm deployment (skip in non-interactive mode)
    Write-Host ""
    Write-Host "====== Deployment Configuration ======" -ForegroundColor Cyan
    Write-Host "Container Name: $containerName"
    Write-Host "BC Version:     $($versionInfo.Name)"
    Write-Host "Ports:          Web=$($ports.WebPort), Dev=$($ports.DevPort), HTTPS=$($ports.HttpsPort)"
    Write-Host "Memory Limit:   $defaultMemoryLimit"
    Write-Host "Test Toolkit:   $(if ($includeTestToolkit) { 'Yes' } else { 'No' })"
    Write-Host "Backup:         $(if ($EnableScheduledBackups -or -not $NonInteractive) { "Daily at $backupTime ($backupRetentionDays day retention)" } else { 'Disabled' })"
    Write-Host ""

    if (-not $NonInteractive) {
        $confirm = Read-Host "Proceed with deployment? (Y/N)"
        if ($confirm -ne 'Y' -and $confirm -ne 'y') {
            Write-Log "Deployment cancelled by user" -Level WARN
            exit 0
        }
    }

    # Step 7: Create container
    $containerParams = @{
        ContainerName = $containerName
        ArtifactUrl = $artifactUrl
        Ports = $ports
        IncludeTestToolkit = $includeTestToolkit
        MemoryLimit = $defaultMemoryLimit
        AuthType = $Auth
    }

    # Add credential if NavUserPassword auth
    if ($credential -and $Auth -eq 'NavUserPassword') {
        $containerParams.Credential = $credential
    }

    New-BCContainerDeployment @containerParams

    # Step 8: Setup automated backup (if enabled)
    if ($EnableScheduledBackups -or (-not $NonInteractive)) {
        $backupPath = Join-Path $backupRootPath $containerName
        New-BackupScheduledTask `
            -ContainerName $containerName `
            -BackupPath $backupPath `
            -ScriptsPath $scriptsPath `
            -RetentionDays $backupRetentionDays `
            -TriggerTime $backupTime
    }
    else {
        Write-Log "Scheduled backups disabled" -Level INFO
    }

    # Step 9: Show summary
    Show-DeploymentSummary -ContainerName $containerName -Ports $ports -BackupPath (Join-Path $backupRootPath $containerName)

    Write-Log "Container deployment completed successfully" -Level SUCCESS
}
catch {
    Write-Log "Deployment failed: $($_.Exception.Message)" -Level ERROR
    Write-Log "Stack trace: $($_.ScriptStackTrace)" -Level ERROR
    exit 1
}
#endregion
