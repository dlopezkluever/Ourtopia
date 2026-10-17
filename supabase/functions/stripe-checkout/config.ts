import type { BillingConfig } from './http.ts';

export function billingConfig(env: (name: string) => string | undefined): BillingConfig {
  const required = (name: string) => { const value = env(name); if (!value) throw new Error(`Missing ${name}.`); return value; };
  return { supabaseUrl: required('SUPABASE_URL'), anonKey: required('SUPABASE_ANON_KEY'),
    workerJwt: required('STRIPE_WORKER_JWT'), stripeKey: required('STRIPE_TEST_SECRET_KEY'),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET'), appOrigin: required('STRIPE_APP_ORIGIN'),
  };
}
