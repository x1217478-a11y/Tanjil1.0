import { auth } from './firebase';

export type AiGenerateMode = 'ask' | 'draft_post' | 'smart_reply';

export interface AiGenerateRequest {
  prompt: string;
  mode?: AiGenerateMode;
  context?: string;
}

export interface AiGenerateResponse {
  text: string;
  model: string;
}

export async function generateAiText(req: AiGenerateRequest): Promise<AiGenerateResponse> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Must be signed in to use AI features');
  }
  const token = await user.getIdToken();

  const resp = await fetch('/api/ai/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(req),
  });

  const data = (await resp.json().catch(() => ({}))) as Partial<AiGenerateResponse> & {
    error?: string;
  };

  if (!resp.ok) {
    throw new Error(data.error || `AI request failed (${resp.status})`);
  }

  return {
    text: data.text || '',
    model: data.model || 'gemini-4-hydrogen',
  };
}
