import { v4 as uuid } from 'uuid';
import type {
  ISignatureProvider,
  RequestSignatureParams,
  SignatureInitResult,
  SignatureStatusResult,
  SignatureCallbackData,
  SignatureCallbackResult,
  SignatureStatus,
} from '../types';

/**
 * Proveedor de firma electrónica de prueba / desarrollo.
 * Simula el flujo completo sin servicio real.
 * Las firmas se completan automáticamente después de 3 segundos.
 */

interface MockSignature {
  signatureId: string;
  documentId: string;
  documentName: string;
  status: SignatureStatus;
  signerName: string;
  signerEmail: string;
  signerRut?: string;
  reference: string;
  createdAt: Date;
  signedAt?: Date;
}

const signatures = new Map<string, MockSignature>();

export class MockSignatureProvider implements ISignatureProvider {
  readonly name = 'mock';

  async requestSignature(params: RequestSignatureParams): Promise<SignatureInitResult> {
    const signatureId = `sig_${uuid().slice(0, 12)}`;

    const sig: MockSignature = {
      signatureId,
      documentId: params.documentId,
      documentName: params.documentName,
      status: 'enviado',
      signerName: params.signer.name,
      signerEmail: params.signer.email,
      signerRut: params.signer.rut,
      reference: params.reference,
      createdAt: new Date(),
    };
    signatures.set(signatureId, sig);

    // Simular firma automática en 3s
    setTimeout(() => {
      const stored = signatures.get(signatureId);
      if (stored && stored.status === 'enviado') {
        stored.status = 'firmado';
        stored.signedAt = new Date();
      }
    }, 3000);

    return {
      success: true,
      signatureId,
      status: 'enviado',
      signingUrl: `https://firma-mock.example.com/sign/${signatureId}`,
      message: 'Solicitud de firma enviada (mock). Esperando firma...',
    };
  }

  async getSignatureStatus(signatureId: string): Promise<SignatureStatusResult> {
    const sig = signatures.get(signatureId);
    if (!sig) {
      return {
        signatureId,
        status: 'error',
        message: 'Firma no encontrada',
      };
    }

    return {
      signatureId,
      status: sig.status,
      signedBy: sig.status === 'firmado' ? sig.signerName : undefined,
      signerRut: sig.status === 'firmado' ? sig.signerRut : undefined,
      signedAt: sig.signedAt,
      signedDocumentUrl: sig.status === 'firmado'
        ? `/uploads/signed_${sig.documentId}.pdf`
        : undefined,
      message: sig.status === 'firmado'
        ? `Documento firmado por ${sig.signerName}`
        : sig.status === 'enviado'
          ? 'Esperando firma del destinatario...'
          : `Estado: ${sig.status}`,
    };
  }

  async cancelSignature(signatureId: string): Promise<{ success: boolean; message: string }> {
    const sig = signatures.get(signatureId);
    if (!sig) {
      return { success: false, message: 'Firma no encontrada' };
    }
    if (sig.status === 'firmado') {
      return { success: false, message: 'No se puede cancelar una firma ya completada.' };
    }
    sig.status = 'rechazado';
    return { success: true, message: 'Solicitud de firma cancelada (mock)' };
  }

  async handleCallback(data: SignatureCallbackData): Promise<SignatureCallbackResult> {
    const signatureId = data.signatureId as string;
    const sig = signatures.get(signatureId);
    if (!sig) {
      return {
        signatureId: signatureId || 'unknown',
        documentId: '',
        status: 'error',
        message: 'Firma no encontrada en callback',
      };
    }

    const newStatus = (data.status as SignatureStatus) || 'firmado';
    sig.status = newStatus;
    if (newStatus === 'firmado') {
      sig.signedAt = new Date();
    }

    return {
      signatureId,
      documentId: sig.documentId,
      status: newStatus,
      signedBy: sig.signerName,
      signerRut: sig.signerRut,
      signedAt: sig.signedAt,
      signedDocumentUrl: newStatus === 'firmado'
        ? `/uploads/signed_${sig.documentId}.pdf`
        : undefined,
      message: `Callback de firma procesado (mock): ${newStatus}`,
    };
  }
}
