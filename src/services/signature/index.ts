import type { ISignatureProvider } from './types';
import { MockSignatureProvider } from './providers/mock';
import { env } from '../../config/env';

/**
 * Registry de proveedores de firma electrónica.
 *
 * Para agregar un proveedor real:
 *   import { ECertChileProvider } from './providers/ecertchile';
 *   registerProvider(new ECertChileProvider());
 */

const providers = new Map<string, ISignatureProvider>();

export function registerProvider(provider: ISignatureProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name?: string): ISignatureProvider {
  const providerName = name || env.SIGNATURE_PROVIDER;
  const provider = providers.get(providerName);
  if (!provider) {
    throw new Error(
      `Proveedor de firma "${providerName}" no registrado. ` +
      `Disponibles: ${[...providers.keys()].join(', ') || 'ninguno'}`
    );
  }
  return provider;
}

export function listProviders(): string[] {
  return [...providers.keys()];
}

// ── Registrar proveedores built-in ──────────────────────────
registerProvider(new MockSignatureProvider());

// Re-export types
export type { ISignatureProvider } from './types';
export type {
  RequestSignatureParams,
  SignatureInitResult,
  SignatureStatusResult,
  SignatureCallbackData,
  SignatureCallbackResult,
  SignatureStatus,
} from './types';
