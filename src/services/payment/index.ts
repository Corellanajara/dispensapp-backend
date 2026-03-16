import type { IPOSPaymentProvider } from './types';
import { MockPOSProvider } from './providers/mock';
import { env } from '../../config/env';

/**
 * Registry de proveedores POS.
 *
 * Para agregar un proveedor real:
 *   import { GeonetProvider } from './providers/geonet';
 *   registerProvider(new GeonetProvider());
 */

const providers = new Map<string, IPOSPaymentProvider>();

export function registerProvider(provider: IPOSPaymentProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name?: string): IPOSPaymentProvider {
  const providerName = name || env.POS_PAYMENT_PROVIDER;
  const provider = providers.get(providerName);
  if (!provider) {
    throw new Error(
      `Proveedor POS "${providerName}" no registrado. ` +
      `Disponibles: ${[...providers.keys()].join(', ') || 'ninguno'}`
    );
  }
  return provider;
}

export function listProviders(): string[] {
  return [...providers.keys()];
}

// ── Registrar proveedores built-in ──────────────────────────
registerProvider(new MockPOSProvider());

// Re-export types
export type { IPOSPaymentProvider } from './types';
export type {
  InitiatePaymentParams,
  PaymentInitResult,
  PaymentStatusResult,
  PaymentCallbackData,
  PaymentCallbackResult,
  PaymentMethod,
  PaymentStatus,
} from './types';
