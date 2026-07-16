const polarisUrl = Deno.env.get('POLARIS_URL') ?? '*'

export const corsOptions = {
  origin:        polarisUrl,
  allowHeaders:  ['Authorization', 'Content-Type'],
  allowMethods:  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge:        86400,
}
