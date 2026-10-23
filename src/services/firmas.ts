import { Types } from 'mongoose';
import { IPatient, IDocument } from '../models/Patient';
import { requirementFor } from '../config/documentos';
import { getProvider } from './signature';
import { env } from '../config/env';

export class FirmaError extends Error {
  status = 400;
}

/**
 * Pide la firma electrónica de un documento del paciente.
 * Solo aplica a los tipos con requiereFirma (reglamento interno y mandato o contrato).
 * El llamador debe guardar el paciente después.
 */
export async function solicitarFirmaDocumento(
  patient: IPatient,
  doc: IDocument,
  firmante: { name: string; email: string; rut?: string },
  solicitadoPor: Types.ObjectId,
  message?: string
) {
  const req = requirementFor(doc.tipo);
  if (!req?.requiereFirma) {
    throw new FirmaError('Este tipo de documento no requiere firma electrónica.');
  }
  if (doc.firma && ['enviado', 'firmado'].includes(doc.firma.estado)) {
    throw new FirmaError(`El documento ya tiene una firma en estado "${doc.firma.estado}".`);
  }

  const provider = getProvider();
  // El proveedor de prueba firma solo a los 3 segundos: en producción mostraría firmas sin validez.
  if (provider.name === 'mock' && env.NODE_ENV === 'production') {
    throw new FirmaError(
      'La firma electrónica aún no está configurada (falta elegir proveedor). El documento queda subido sin firma.'
    );
  }
  const result = await provider.requestSignature({
    documentId: doc._id.toString(),
    documentName: doc.nombre,
    documentPath: doc.archivo,
    signer: firmante,
    reference: `${patient.rut} - ${req.label}`,
    message,
  });

  doc.firma = {
    signatureId: result.signatureId,
    provider: provider.name,
    estado: result.status,
    signingUrl: result.signingUrl,
    solicitadoPor,
    fechaSolicitud: new Date(),
  };

  return result;
}

/**
 * Consulta al proveedor el estado de una firma en curso y actualiza el documento.
 * @returns true si cambió (el llamador debe guardar el paciente).
 */
export async function actualizarEstadoFirma(doc: IDocument): Promise<boolean> {
  if (!doc.firma || doc.firma.estado !== 'enviado') return false;

  const provider = getProvider(doc.firma.provider);
  const status = await provider.getSignatureStatus(doc.firma.signatureId);
  if (status.status === doc.firma.estado) return false;

  doc.firma.estado = status.status;
  if (status.status === 'firmado') {
    doc.firma.firmadoPor = status.signedBy;
    doc.firma.rutFirmante = status.signerRut;
    doc.firma.fechaFirma = status.signedAt;
    doc.firma.archivoFirmado = status.signedDocumentUrl;
  }
  return true;
}
