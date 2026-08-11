# Polaris API

Supabase Edge Functions powering the Polaris dashboard.

## Deploy

From the `polaris-api` project root, deploy the API Edge Function to the linked Supabase project:

```bash
supabase functions deploy api
```

## Support Ticket Confirmation Emails

Confirmation emails are sent by the **constell8tion** Next.js app (`lib/support-email.ts`), not this API. When a ticket is submitted via the `/support` form, the route handler inserts the ticket into Supabase and immediately calls Resend — no webhook or edge function involved on this side.
