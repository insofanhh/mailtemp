type Environment = Record<string, string | undefined>;

function origin(value: string | undefined, platform = false): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(platform ? `https://${value.trim()}` : value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function publicHttps(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'https:' && !['localhost', '[::1]'].includes(url.hostname)
    && !url.hostname.endsWith('.localhost') && !/^127\./.test(url.hostname);
}

function deploymentOrigins(env: Environment): string[] {
  if (env.VERCEL !== '1') return [];
  return [env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_URL, env.VERCEL_BRANCH_URL]
    .map(value => origin(value, true)).filter((value): value is string => Boolean(value && publicHttps(value)));
}

export function appOrigin(env: Environment = process.env): string {
  const configured = origin(env.APP_URL);
  if (configured && (env.VERCEL !== '1' || publicHttps(configured))) return configured;
  const [deployment] = deploymentOrigins(env);
  if (deployment) return deployment;
  if (env.VERCEL === '1' || env.APP_URL?.trim()) {
    throw new Error('Chưa có domain ứng dụng hợp lệ. Đặt APP_URL bằng URL HTTPS production hoặc bật System Environment Variables của Vercel.');
  }
  return 'http://localhost:3000';
}

export function hasTrustedOrigin(request: Request, env: Environment = process.env): boolean {
  const source = request.headers.get('origin');
  if (!source || source === 'null' || request.headers.get('sec-fetch-site') === 'cross-site') return false;
  let canonical: string;
  try { canonical = appOrigin(env); } catch { return false; }
  // Only configured origins and exact domains supplied by Vercel are trusted.
  // Request Host / X-Forwarded-Host / Origin never extend this list.
  return new Set([canonical, ...deploymentOrigins(env)]).has(source);
}
