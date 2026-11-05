import fs from 'fs';
import { Types } from 'mongoose';
import { FirmaDemo, IFirmaDemo } from '../models/FirmaDemo';
import { configFirma } from './configuracion';
import { readFileBuffer, uploadFile } from './storage';
import {
  FirmaError,
  proveedorActivo,
  certificadoVigente,
  solicitarCertificado,
  actualizarEstadoFirma,
  formatearRut,
  formatearTelefono,
  retornoFirma,
  type DatosEnrolamiento,
} from './firmas';

/**
 * Firma de prueba del administrador: sube un PDF, obtiene (si falta) el certificado del firmante
 * y lo firma en Signapis, igual que haría un paciente. No toca fichas de pacientes.
 */

const MAX_PDF = 5 * 1024 * 1024; // límite de Signapis

export interface VistaFirmaDemo {
  _id: string;
  nombre: string;
  rut: string;
  email: string;
  nombreArchivo: string;
  createdAt: Date;
  certificado: {
    requiere: boolean;
    estado: 'no_aplica' | 'activo' | 'enrolando' | 'falta' | 'fallido';
    mensaje?: string;
    enrolamientoUrl?: string;
  };
  firma: null | {
    estado: string;
    mensaje?: string;
    signingUrl?: string;
    firmadoPor?: string;
    fechaFirma?: Date;
    tieneArchivoFirmado: boolean;
  };
}

export function vistaDemo(demo: IFirmaDemo, requiere: boolean): VistaFirmaDemo {
  const c = demo.certificadoFirma;
  const estadoCert: VistaFirmaDemo['certificado']['estado'] = !requiere
    ? 'no_aplica'
    : c?.estado === 'activo'
      ? 'activo'
      : c?.estado === 'enrolando'
        ? 'enrolando'
        : c?.estado === 'fallido'
          ? 'fallido'
          : 'falta';
  const f = demo.firma;
  return {
    _id: demo._id.toString(),
    nombre: demo.nombre,
    rut: demo.rut,
    email: demo.email,
    nombreArchivo: demo.nombreArchivo,
    createdAt: demo.createdAt,
    certificado: {
      requiere,
      estado: estadoCert,
      mensaje: c?.mensaje,
      enrolamientoUrl: estadoCert === 'enrolando' ? c?.enrolamientoUrl : undefined,
    },
    firma: f
      ? {
          estado: f.estado,
          mensaje: f.mensaje,
          signingUrl: f.estado === 'enviado' ? f.signingUrl : undefined,
          firmadoPor: f.firmadoPor,
          fechaFirma: f.fechaFirma,
          tieneArchivoFirmado: !!f.archivoFirmado,
        }
      : null,
  };
}

function esPdf(file: Express.Multer.File): boolean {
  try {
    const fd = fs.openSync(file.path, 'r');
    const cabecera = Buffer.alloc(5);
    fs.readSync(fd, cabecera, 0, 5, 0);
    fs.closeSync(fd);
    return cabecera.toString('latin1') === '%PDF-';
  } catch {
    return false;
  }
}

/** Crea la firma de prueba con el PDF subido. */
export async function crearDemo(
  datos: { nombre: string; rut: string; email: string; telefono?: string },
  file: Express.Multer.File | undefined,
  usuario: Types.ObjectId
): Promise<IFirmaDemo> {
  proveedorActivo();
  if (!file) throw new FirmaError('Sube el PDF que quieres firmar.', 400, 'ARCHIVO');
  const descartar = () => fs.promises.unlink(file.path).catch(() => undefined);
  if (file.mimetype !== 'application/pdf' || !esPdf(file)) {
    await descartar();
    throw new FirmaError('El archivo debe ser un PDF.', 400, 'ARCHIVO');
  }
  if (file.size > MAX_PDF) {
    await descartar();
    throw new FirmaError('El PDF no puede pesar más de 5 MB.', 400, 'ARCHIVO');
  }

  const archivo = await uploadFile(file, { privado: true });
  return FirmaDemo.create({
    nombre: datos.nombre.trim(),
    rut: formatearRut(datos.rut),
    email: datos.email.trim().toLowerCase(),
    telefono: formatearTelefono(datos.telefono) ?? undefined,
    archivo,
    nombreArchivo: file.originalname || 'documento.pdf',
    creadoPor: usuario,
  });
}

/** Consulta al proveedor el certificado y la firma, y guarda los cambios. */
export async function refrescarDemo(demo: IFirmaDemo): Promise<VistaFirmaDemo> {
  const provider = proveedorActivo();
  if (provider.requiresCertificate) {
    await certificadoVigente(demo, provider).catch((err) =>
      console.warn('[firma prueba] No se pudo consultar el certificado:', (err as Error).message)
    );
    demo.markModified('certificadoFirma');
  }
  if (await actualizarEstadoFirma(demo).catch(() => false)) demo.markModified('firma');
  await demo.save();
  return vistaDemo(demo, provider.requiresCertificate);
}

/** Pide el certificado de firma para el correo de la prueba. */
export async function certificadoDemo(demo: IFirmaDemo, datos: DatosEnrolamiento) {
  const result = await solicitarCertificado(demo, datos, retornoFirma.prueba(), { esPrueba: true });
  demo.markModified('certificadoFirma');
  await demo.save();
  return { enrollUrl: result.enrollUrl, message: 'Certificado solicitado. Falta validar la identidad en Signapis.' };
}

/** Envía el PDF de prueba a firmar. Si ya hay una firma en curso devuelve el mismo enlace. */
export async function firmarDemo(demo: IFirmaDemo, usuario: Types.ObjectId) {
  const provider = proveedorActivo();
  if (demo.firma?.estado === 'firmado') throw new FirmaError('Este documento ya está firmado.', 409, 'ESTADO');
  if (demo.firma?.estado === 'enviado' && demo.firma.provider === provider.name && demo.firma.signingUrl) {
    return { signingUrl: demo.firma.signingUrl, message: 'La firma ya está en curso.' };
  }

  let certificateSerial: string | undefined;
  if (provider.requiresCertificate) {
    certificateSerial = (await certificadoVigente(demo, provider)) ?? undefined;
    if (!certificateSerial) {
      demo.markModified('certificadoFirma');
      await demo.save();
      const enCurso = demo.certificadoFirma?.estado === 'enrolando';
      throw new FirmaError(
        enCurso
          ? 'Aún no termina la validación de identidad en Signapis.'
          : 'Primero hay que obtener el certificado de firma de este correo.',
        409,
        enCurso ? 'CERTIFICADO_EN_CURSO' : 'REQUIERE_CERTIFICADO'
      );
    }
  }

  const archivo = await readFileBuffer(demo.archivo);
  if (!archivo) throw new FirmaError('No se encontró el PDF de la prueba. Crea una nueva.', 404, 'ARCHIVO');

  const cfg = configFirma();
  const result = await provider.requestSignature({
    documentId: demo._id.toString(),
    documentName: `Prueba ${demo.nombreArchivo.replace(/\.pdf$/i, '')}`,
    document: archivo,
    signer: { name: demo.nombre, email: demo.email, rut: demo.rut },
    certificateSerial,
    reference: `Firma de prueba - ${demo.rut}`,
    redirectUrl: retornoFirma.prueba(),
    estampa: { tipoEstampa: cfg.tipoEstampa, textoEstampa: cfg.textoEstampa, conQR: cfg.conQR, posicion: cfg.posicion },
  });

  demo.firma = {
    signatureId: result.signatureId,
    provider: provider.name,
    estado: result.status,
    signingUrl: result.signingUrl,
    solicitadoPor: usuario,
    fechaSolicitud: new Date(),
    mensaje: result.message,
    fechaActualizacion: new Date(),
  };
  await demo.save();
  return { signingUrl: result.signingUrl, message: result.message };
}
