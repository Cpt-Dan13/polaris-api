const polarisUrl = Deno.env.get('POLARIS_URL') ?? ''
const devUrl = Deno.env.get('POLARIS_DEV_URL') ?? 'http://localhost:5173'

const allowedOrigins = [polarisUrl, devUrl].filter(
  (origin): origin is string => Boolean(origin),
)

export const corsOptions = {
  origin: allowedOrigins,
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}