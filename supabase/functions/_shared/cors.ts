const polarisUrl = Deno.env.get('POLARIS_URL') ?? '*'
const devUrl     = Deno.env.get('POLARIS_DEV_URL') ?? 'http://localhost:5173'

const ALLOWED = [polarisUrl, devUrl].filter(Boolean)

export const corsOptions = {
  origin:        polarisUrl,
  allowHeaders:  ['Authorization', 'Content-Type'],
  allowMethods:  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge:        86400,
}
