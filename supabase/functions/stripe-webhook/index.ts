import { billingConfig } from '../stripe-checkout/config.ts';
import { billingHandlers } from '../stripe-checkout/http.ts';
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
Deno.serve(billingHandlers(billingConfig(name => Deno.env.get(name))).webhook);
