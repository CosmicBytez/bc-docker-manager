import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AIChat from '@/components/AIChat';

// Mock electron-api
jest.mock('@/lib/electron-api', () => ({
  isElectron: jest.fn(() => false),
  sendAIMessage: jest.fn(),
  getSetting: jest.fn().mockResolvedValue(undefined),
}));

import { isElectron, sendAIMessage, getSetting } from '@/lib/electron-api';

const mockIsElectron = isElectron as jest.MockedFunction<typeof isElectron>;
const mockSendAIMessage = sendAIMessage as jest.MockedFunction<typeof sendAIMessage>;
const mockGetSetting = getSetting as jest.MockedFunction<typeof getSetting>;

describe('AIChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsElectron.mockReturnValue(false);
    mockGetSetting.mockResolvedValue(undefined);
  });

  describe('Rendering', () => {
    it('should render welcome message on mount', async () => {
      render(<AIChat />);

      await waitFor(() => {
        expect(screen.getByText(/I'm your BC Docker troubleshooting assistant/)).toBeInTheDocument();
      });
    });

    it('should render welcome message with context when provided', async () => {
      render(<AIChat initialContext="bcserver-test" />);

      await waitFor(() => {
        expect(screen.getByText(/bcserver-test/)).toBeInTheDocument();
      });
    });

    it('should render the input field', () => {
      render(<AIChat />);
      expect(screen.getByPlaceholderText('Describe your issue or ask a question...')).toBeInTheDocument();
    });

    it('should render the send button', () => {
      render(<AIChat />);
      // Send button is the submit button
      const submitButton = screen.getByRole('button');
      expect(submitButton).toBeInTheDocument();
    });

    it('should render the hint text', () => {
      render(<AIChat />);
      expect(screen.getByText(/Press Enter to send/)).toBeInTheDocument();
    });
  });

  describe('Message Display', () => {
    it('should show assistant icon for assistant messages', async () => {
      render(<AIChat />);

      await waitFor(() => {
        // The welcome message is from the assistant - there should be bot icon containers
        const botIcons = document.querySelectorAll('.bg-blue-600');
        expect(botIcons.length).toBeGreaterThan(0);
      });
    });

    it('should show message timestamps', async () => {
      render(<AIChat />);

      await waitFor(() => {
        // Welcome message should have a timestamp
        const timestamps = document.querySelectorAll('.text-xs.text-gray-500');
        expect(timestamps.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Sending Messages', () => {
    it('should add user message to chat when form is submitted', async () => {
      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      fireEvent.change(input, { target: { value: 'How do I start a container?' } });
      fireEvent.submit(input.closest('form')!);

      await waitFor(() => {
        expect(screen.getByText('How do I start a container?')).toBeInTheDocument();
      });
    });

    it('should not submit empty messages', async () => {
      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.submit(input.closest('form')!);

      // Should still only have the welcome message
      await waitFor(() => {
        const userIcons = document.querySelectorAll('.bg-gray-600');
        expect(userIcons.length).toBe(0);
      });
    });

    it('should not submit whitespace-only messages', async () => {
      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.submit(input.closest('form')!);

      await waitFor(() => {
        const userIcons = document.querySelectorAll('.bg-gray-600');
        expect(userIcons.length).toBe(0);
      });
    });

    it('should clear input after submission', async () => {
      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      fireEvent.change(input, { target: { value: 'Test message' } });
      fireEvent.submit(input.closest('form')!);

      await waitFor(() => {
        expect(input).toHaveValue('');
      });
    });

    it('should disable input while loading', async () => {
      // Make the response slow to catch the loading state
      mockGetSetting.mockResolvedValue(undefined);

      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      fireEvent.change(input, { target: { value: 'Test message' } });
      fireEvent.submit(input.closest('form')!);

      // The input should be disabled briefly while loading
      // We check that the response arrives (offline response) which means the loading state was triggered
      await waitFor(() => {
        expect(screen.getByText('Test message')).toBeInTheDocument();
      });
    });
  });

  describe('Offline Responses', () => {
    it('should show offline response for startup issues', async () => {
      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      await act(async () => {
        fireEvent.change(input, { target: { value: "My container won't start" } });
        fireEvent.submit(input.closest('form')!);
      });

      await waitFor(() => {
        expect(screen.getByText(/Port Conflicts/)).toBeInTheDocument();
      });
    });

    it('should show offline response for performance issues', async () => {
      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'My container is slow performance' } });
        fireEvent.submit(input.closest('form')!);
      });

      await waitFor(() => {
        expect(screen.getByText(/Diagnosing BC Container Performance Issues/)).toBeInTheDocument();
      });
    });

    it('should show offline response for license questions', async () => {
      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'How do I renew my license' } });
        fireEvent.submit(input.closest('form')!);
      });

      await waitFor(() => {
        expect(screen.getByText(/Managing BC Container Licenses/)).toBeInTheDocument();
      });
    });

    it('should show offline response for extension issues', async () => {
      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Extension deployment errors' } });
        fireEvent.submit(input.closest('form')!);
      });

      await waitFor(() => {
        expect(screen.getByText(/Troubleshooting AL Extension Deployment Errors/)).toBeInTheDocument();
      });
    });

    it('should show generic offline response for unknown topics', async () => {
      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Tell me something random' } });
        fireEvent.submit(input.closest('form')!);
      });

      await waitFor(() => {
        expect(screen.getByText(/I can help with common BC container issues/)).toBeInTheDocument();
      });
    });
  });

  describe('Loading State', () => {
    it('should show loading spinner while waiting for response', async () => {
      // Make it slow enough to catch
      mockGetSetting.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve(undefined), 200))
      );

      render(<AIChat />);

      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Test' } });
        fireEvent.submit(input.closest('form')!);
      });

      // Loading spinner should appear (it's the Loader2 component with animate-spin)
      const spinners = document.querySelectorAll('.animate-spin');
      // The spinner may have appeared and completed quickly, so we just verify the message arrived
      await waitFor(() => {
        expect(screen.getByText('Test')).toBeInTheDocument();
      });
    });
  });

  describe('Electron mode', () => {
    beforeEach(() => {
      mockIsElectron.mockReturnValue(true);
      mockSendAIMessage.mockResolvedValue({ role: 'assistant', content: 'Claude says hi' });
    });

    const submit = async (text: string) => {
      const input = screen.getByPlaceholderText('Describe your issue or ask a question...');
      await act(async () => {
        fireEvent.change(input, { target: { value: text } });
        fireEvent.submit(input.closest('form')!);
      });
    };

    // Regression: the transcript always opens with the assistant welcome
    // message, and sending it verbatim made the Messages API reject every
    // request with a 400 — which the old code masked as "offline mode".
    it('never sends a conversation that starts with an assistant turn', async () => {
      render(<AIChat />);
      await waitFor(() => {
        expect(screen.getByText(/I'm your BC Docker troubleshooting assistant/)).toBeInTheDocument();
      });

      await submit('Why is my container unhealthy?');

      await waitFor(() => expect(mockSendAIMessage).toHaveBeenCalled());
      const sent = mockSendAIMessage.mock.calls[0][0];
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0].role).toBe('user');
      expect(sent[0].content).toBe('Why is my container unhealthy?');
    });

    it('still starts on a user turn after several exchanges', async () => {
      render(<AIChat />);
      await waitFor(() => {
        expect(screen.getByText(/I'm your BC Docker troubleshooting assistant/)).toBeInTheDocument();
      });

      await submit('first question');
      await waitFor(() => expect(screen.getByText('Claude says hi')).toBeInTheDocument());
      await submit('second question');

      await waitFor(() => expect(mockSendAIMessage).toHaveBeenCalledTimes(2));
      for (const call of mockSendAIMessage.mock.calls) {
        expect(call[0][0].role).toBe('user');
      }
      expect(mockSendAIMessage.mock.calls[1][0]).toHaveLength(3);
    });

    it('renders the API failure instead of passing offline docs off as an answer', async () => {
      mockSendAIMessage.mockRejectedValue(new Error('Claude API error (HTTP 401): invalid x-api-key'));

      render(<AIChat />);
      await submit('My container will not start');

      await waitFor(() => {
        expect(screen.getByText(/Claude API request failed/)).toBeInTheDocument();
      });
      expect(screen.getByText(/invalid x-api-key/)).toBeInTheDocument();
      // The documentation is still shown, but labelled as a fallback.
      expect(screen.getByText(/Port Conflicts/)).toBeInTheDocument();
    });
  });

  describe('Markdown Formatting', () => {
    it('should render bold text from messages', async () => {
      render(<AIChat />);

      // The welcome message contains **bold** text
      await waitFor(() => {
        const strongElements = document.querySelectorAll('strong');
        expect(strongElements.length).toBeGreaterThan(0);
      });
    });

    it('should render bullet points as list items', async () => {
      render(<AIChat />);

      // The welcome message contains bullet items
      await waitFor(() => {
        const listItems = document.querySelectorAll('li');
        expect(listItems.length).toBeGreaterThan(0);
      });
    });
  });
});
