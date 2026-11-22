/**
 * Documentos del paciente.
 *
 * Basado en la reunión del 22-10-2026 (pendiente de validar con asesoría legal):
 * - Receta, certificado de antecedentes, reglamento interno y mandato o contrato.
 * - Firma electrónica solo para reglamento interno y mandato o contrato.
 * - 22-11-2026: el reglamento y el contrato los genera la plataforma desde plantillas que edita el
 *   administrador (con los datos del paciente); el paciente solo los firma. El certificado de
 *   antecedentes lo sube el paciente y el dispensario lo revisa en la bandeja de validación.
 *
 * Para cambiar qué se exige, edita esta lista. El frontend lee la misma lista desde GET /api/config.
 */

export type DocumentType =
  | 'receta_medica'
  | 'certificado_antecedentes'
  | 'reglamento_interno'
  | 'mandato_contrato'
  | 'cedula_identidad'
  | 'otro';

export const DOCUMENT_TYPES: DocumentType[] = [
  'receta_medica',
  'certificado_antecedentes',
  'reglamento_interno',
  'mandato_contrato',
  'cedula_identidad',
  'otro',
];

export interface DocumentRequirement {
  tipo: DocumentType;
  label: string;
  descripcion: string;
  /** Exige firma electrónica del paciente. */
  requiereFirma: boolean;
  /** Exige fecha de vencimiento al subirlo. */
  requiereVencimiento: boolean;
  /**
   * Si es true, el paciente no se puede activar sin este documento aprobado (y firmado si aplica).
   * Si es false, solo se muestra como advertencia al activar.
   */
  bloqueaActivacion: boolean;
  /** Lo genera la plataforma desde la plantilla del administrador: el paciente no lo sube, lo firma. */
  generadoPorPlataforma?: boolean;
  /** Sin firma, pero el dispensario lo revisa (aprueba o rechaza) en la bandeja de validación. */
  revisionEnBandeja?: boolean;
}

/** Documentos que la plataforma genera desde una plantilla editable por el administrador. */
export const TIPOS_GENERADOS = ['reglamento_interno', 'mandato_contrato'] as const;
export type TipoGenerado = (typeof TIPOS_GENERADOS)[number];

export function esTipoGenerado(tipo: string): tipo is TipoGenerado {
  return (TIPOS_GENERADOS as readonly string[]).includes(tipo);
}

export const REQUIRED_DOCUMENTS: DocumentRequirement[] = [
  {
    tipo: 'receta_medica',
    label: 'Receta médica',
    descripcion: 'Receta vigente emitida por el médico tratante, con fecha de vencimiento.',
    requiereFirma: false,
    requiereVencimiento: true,
    bloqueaActivacion: true,
  },
  {
    tipo: 'certificado_antecedentes',
    label: 'Certificado de antecedentes',
    descripcion: 'Certificado de antecedentes del paciente. Lo sube el paciente y lo revisa el dispensario.',
    requiereFirma: false,
    requiereVencimiento: false,
    bloqueaActivacion: false,
    revisionEnBandeja: true,
  },
  {
    tipo: 'reglamento_interno',
    label: 'Reglamento interno',
    descripcion: 'Reglamento interno del dispensario. Lo genera la plataforma con tus datos y lo firmas electrónicamente.',
    requiereFirma: true,
    requiereVencimiento: false,
    bloqueaActivacion: false,
    generadoPorPlataforma: true,
  },
  {
    tipo: 'mandato_contrato',
    label: 'Mandato o contrato',
    descripcion: 'Mandato o contrato con el dispensario. Lo genera la plataforma con tus datos y lo firmas electrónicamente.',
    requiereFirma: true,
    requiereVencimiento: false,
    bloqueaActivacion: false,
    generadoPorPlataforma: true,
  },
];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  receta_medica: 'Receta médica',
  certificado_antecedentes: 'Certificado de antecedentes',
  reglamento_interno: 'Reglamento interno',
  mandato_contrato: 'Mandato o contrato',
  cedula_identidad: 'Cédula de identidad',
  otro: 'Otro',
};

export function requirementFor(tipo: string): DocumentRequirement | undefined {
  return REQUIRED_DOCUMENTS.find((r) => r.tipo === tipo);
}
