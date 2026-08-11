const RESEND_URL = 'https://api.resend.com'
const FROM       = 'Constell8tion LLC <help@constell8tion.com>'

function apiKey(): string {
  const key = Deno.env.get('RESEND_API_KEY')
  if (!key) throw new Error('RESEND_API_KEY secret is not set')
  return key
}

function headers(idempotencyKey?: string) {
  return {
    'Authorization': `Bearer ${apiKey()}`,
    'Content-Type':  'application/json',
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmailPayload {
  to:              string
  subject:         string
  html:            string
  idempotencyKey?: string
}

export interface SendResult {
  sent:   number
  failed: number
}

// ── Single send ───────────────────────────────────────────────────────────────

export async function sendEmail({ to, subject, html, idempotencyKey }: EmailPayload): Promise<void> {
  const res = await fetch(`${RESEND_URL}/emails`, {
    method:  'POST',
    headers: headers(idempotencyKey),
    body:    JSON.stringify({ from: FROM, to, subject, html }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Resend error (${res.status}): ${err.message ?? res.statusText}`)
  }
}

// ── Batch send ────────────────────────────────────────────────────────────────
// Resend batch endpoint accepts max 100 emails per request.
// This function chunks automatically so callers don't need to worry about limits.

export async function sendBatch(emails: EmailPayload[]): Promise<SendResult> {
  if (emails.length === 0) return { sent: 0, failed: 0 }

  const chunks: EmailPayload[][] = []
  for (let i = 0; i < emails.length; i += 100) {
    chunks.push(emails.slice(i, i + 100))
  }

  let sent   = 0
  let failed = 0

  for (const chunk of chunks) {
    const payload = chunk.map(({ to, subject, html }) => ({ from: FROM, to, subject, html }))

    const res = await fetch(`${RESEND_URL}/emails/batch`, {
      method:  'POST',
      headers: headers(),
      body:    JSON.stringify(payload),
    })

    if (res.ok) {
      const data = await res.json().catch(() => ({ data: [] }))
      // Resend returns an array of results — count individually
      const results: { id?: string; error?: unknown }[] = data?.data ?? []
      for (const r of results) {
        r.id ? sent++ : failed++
      }
      // Fallback: if response shape is unexpected, credit the whole chunk
      if (results.length === 0) sent += chunk.length
    } else {
      failed += chunk.length
    }
  }

  return { sent, failed }
}
