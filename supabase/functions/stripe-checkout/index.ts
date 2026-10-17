import { billingConfig } from './config.ts';
import { billingHandlers } from './http.ts';
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
Deno.serve(billingHandlers(billingConfig(name => Deno.env.get(name))).checkout);
