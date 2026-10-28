import { Types } from 'mongoose';
import { Configuracion, IConfigFirma, CONFIG_FIRMA_POR_DEFECTO } from '../models/Configuracion';
import { REQUIRED_DOCUMENTS, DocumentRequirement, DOCUMENT_TYPE_LABELS, DocumentType } from '../config/documentos';

/**
 * Configuración que el administrador cambia desde la app (hoy: firma electrónica).
 * Se guarda en Mongo y se mantiene en memoria para que las validaciones sigan siendo síncronas.
 * Se recarga cada minuto por si hay más de una instancia del backend.
 */

let firmaActual: IConfigFirma = { ...CONFIG_FIRMA_POR_DEFECTO };
let recarga: NodeJS.Timeout | null = null;

function limpiar(firma: Partial<IConfigFirma> | undefined): IConfigFirma {
  // Un subdocumento de Mongoose no se puede copiar con spread: primero se pasa a objeto plano.
  const plano =
    firma && typeof (firma as { toObject?: () => unknown }).toObject === 'function'
      ? ((firma as unknown as { toObject: () => Partial<IConfigFirma> }).toObject())
      : firma;
  const f = { ...CONFIG_FIRMA_POR_DEFECTO, ...(plano ?? {}) };
  return {
    habilitada: !!f.habilitada,
    tiposConFirma: [...(f.tiposConFirma ?? [])],
    tipoEstampa: f.tipoEstampa,
    textoEstampa: f.textoEstampa ?? '',
    conQR: !!f.conQR,
    posicion: f.posicion ? { pagina: f.posicion.pagina, x: f.posicion.x, y: f.posicion.y } : null,
    vigenciaCertificadoAnios: f.vigenciaCertificadoAnios,
  };
}

async function obtenerDocumento() {
  return (
    (await Configuracion.findOne({ clave: 'general' })) ??
    (await Configuracion.create({ clave: 'general', firma: { ...CONFIG_FIRMA_POR_DEFECTO } }))
  );
}

/** Lee la configuración desde la base de datos. Llamar al iniciar el servidor. */
export async function cargarConfiguracion(): Promise<void> {
  const doc = await obtenerDocumento();
  firmaActual = limpiar(doc.firma);
  if (!recarga) {
    recarga = setInterval(() => {
      Configuracion.findOne({ clave: 'general' })
        .lean()
        .then((d) => {
          if (d) firmaActual = limpiar(d.firma);
        })
        .catch((err) => console.error('[configuracion] Error al recargar:', err));
    }, 60_000);
    recarga.unref();
  }
}

export function configFirma(): IConfigFirma {
  return firmaActual;
}

export async function actualizarConfigFirma(
  cambios: Partial<IConfigFirma>,
  usuario: Types.ObjectId
): Promise<IConfigFirma> {
  const doc = await obtenerDocumento();
  const nueva = limpiar({ ...limpiar(doc.firma), ...cambios });
  doc.firma = nueva;
  doc.actualizadoPor = usuario;
  doc.markModified('firma');
  await doc.save();
  firmaActual = nueva;
  return nueva;
}

/** true si los documentos de este tipo se firman electrónicamente con la configuración actual. */
export function tipoRequiereFirma(tipo: string): boolean {
  return firmaActual.habilitada && firmaActual.tiposConFirma.includes(tipo as DocumentType);
}

/** Documentos exigidos al paciente, con la exigencia de firma según lo que decidió el administrador. */
export function documentosRequeridos(): DocumentRequirement[] {
  return REQUIRED_DOCUMENTS.map((r) => ({ ...r, requiereFirma: tipoRequiereFirma(r.tipo) }));
}

/** Requisito de un tipo de documento (incluye tipos no exigidos, como "otro", si el admin les pidió firma). */
export function requisitoPara(tipo: string): DocumentRequirement | undefined {
  const base = REQUIRED_DOCUMENTS.find((r) => r.tipo === tipo);
  if (base) return { ...base, requiereFirma: tipoRequiereFirma(tipo) };
  if (!tipoRequiereFirma(tipo)) return undefined;
  return {
    tipo: tipo as DocumentType,
    label: DOCUMENT_TYPE_LABELS[tipo as DocumentType] ?? tipo,
    descripcion: '',
    requiereFirma: true,
    requiereVencimiento: false,
    bloqueaActivacion: false,
  };
}
