import type { ISignatureProvider } from './types';
import { MockSignatureProvider } from './providers/mock';
import { SignapisProvider } from './providers/signapis';
import { env } from '../../config/env';

/**
 * Registro de proveedores de firma electrónica. El activo se elige con SIGNATURE_PROVIDER.
 * - signapis: firma electrónica avanzada real (sandbox o producción según SIGNAPIS_AMBIENTE).
 * - mock: solo desarrollo local, firma sola y sin validez legal.
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

registerProvider(new MockSignatureProvider());
registerProvider(new SignapisProvider());

export * from './types';
