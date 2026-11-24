import { Types } from 'mongoose';
import { Patient, IPatient, IDocument, EtapaRegistro, ganchosPaciente } from '../models/Patient';
import { DOCUMENT_TYPE_LABELS, DocumentType } from '../config/documentos';
import { documentosRequeridos, tipoRequiereContrafirma } from './configuracion';
import { inicioDelDia, verificarRequisitosActivacion } from './vigencia';
import { Aviso, notificar, personalDelPaciente } from './notificaciones';

/**
 * Registro del paciente por etapas:
 *   1. documentos  → sube la receta médica y el certificado de antecedentes.
 *   2. revision    → el dispensario los revisa (y registra lo que autoriza la receta).
 *   3. firma       → firma el reglamento y el contrato que genera la plataforma.
 *      validacion  → el dispensario valida y contrafirma lo que firmó.
 *   Con la última contrafirma el paciente queda activo, sin pasos manuales.
 *
 * Cada cambio de etapa (y cada documento rechazado) se avisa al paciente y al personal que corresponde,
 * dentro de la app y por correo si hay SMTP. Los avisos salen de los ganchos de guardado del paciente,
 * así que cubren cualquier camino: rutas, webhooks de firma y la revisión periódica de vigencias.
 */

/** Número de etapa que ve el paciente (1, 2 o 3). */
export const NUMERO_ETAPA: Partial<Record<EtapaRegistro, number>> = {
  documentos: 1,
  revision: 2,
  firma: 3,
  validacion: 3,
  activacion: 3,
};

function ultimosPorTipo(patient: Pick<IPatient, 'documentos'>): Map<string, IDocument> {
  const porTipo = new Map<string, IDocument>();
  for (const d of patient.documentos ?? []) {
    const actual = porTipo.get(d.tipo);
    if (!actual || new Date(d.fechaSubida).getTime() >= new Date(actual.fechaSubida).getTime()) porTipo.set(d.tipo, d);
  }
  return porTipo;
}

/** Documentos que el paciente sube (etapa 1) y documentos que firma (etapa 3), según la configuración actual. */
export function documentosPorEtapa() {
  const requeridos = documentosRequeridos();
  return {
    ingreso: requeridos.filter((r) => !r.generadoPorPlataforma),
    firma: requeridos.filter((r) => r.generadoPorPlataforma && r.requiereFirma),
  };
}

/** Receta aprobada pero ya vencida: cuenta como faltante (hay que subir una nueva). */
function recetaVencida(doc: IDocument): boolean {
  return doc.tipo === 'receta_medica' && (!doc.fechaVencimiento || new Date(doc.fechaVencimiento) < inicioDelDia());
}

export function calcularEtapa(patient: Pick<IPatient, 'estado' | 'documentos'>): EtapaRegistro {
  if (patient.estado === 'aprobado') return 'activo';
  if (patient.estado === 'suspendido') return 'suspendido';
  if (patient.estado === 'rechazado') return 'rechazado';

  const ultimos = ultimosPorTipo(patient);
  const { ingreso, firma } = documentosPorEtapa();

  let enRevision = false;
  for (const req of ingreso) {
    const d = ultimos.get(req.tipo);
    if (!d || d.estado === 'rechazado') return 'documentos';
    if (d.estado === 'pendiente') enRevision = true;
    else if (recetaVencida(d)) return 'documentos';
  }
  if (enRevision) return 'revision';

  let porValidar = false;
  for (const req of firma) {
    const d = ultimos.get(req.tipo);
    if (!d || d.estado === 'rechazado' || d.firma?.estado !== 'firmado') return 'firma';
    if (tipoRequiereContrafirma(d.tipo) && d.contrafirma?.estado !== 'firmado') porValidar = true;
  }
  if (porValidar) return 'validacion';
  return 'activacion';
}

// ─── Ganchos de guardado ───────────────────────────────────

interface EstadoDoc {
  estado: string;
  firma?: string;
}

interface Locales {
  docsPrevios?: Map<string, EstadoDoc>;
  avisos?: Array<{ paraPaciente: boolean; aviso: Aviso }>;
}

const locales = (p: IPatient) => p.$locals as Locales;

function recordarEstadoDocumentos(patient: IPatient): void {
  locales(patient).docsPrevios = new Map(
    (patient.documentos ?? []).map((d) => [String(d._id), { estado: d.estado, firma: d.firma?.estado }])
  );
}

const etiqueta = (tipo: string) => DOCUMENT_TYPE_LABELS[tipo as DocumentType] ?? tipo;
const lista = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs.at(-1)}`);

/** Activa al paciente si completó las 3 etapas. Devuelve true si lo activó. */
function activarSiCompleto(patient: IPatient, etapa: EtapaRegistro): boolean {
  if (patient.estado !== 'pendiente' || etapa !== 'activacion') return false;
  const { firma } = documentosPorEtapa();
  // Sin firma electrónica no hay validación del dispensario: lo activa un administrador.
  if (firma.length === 0 || !patient.sucursal) return false;
  if (verificarRequisitosActivacion(patient).bloqueantes.length > 0) return false;

  // Queda activado por el responsable que hizo la última contrafirma.
  const ultimos = ultimosPorTipo(patient);
  const firmados = firma.map((r) => ultimos.get(r.tipo)).filter(Boolean) as IDocument[];
  const ultimo = firmados.sort(
    (a, b) =>
      new Date(b.contrafirma?.fechaFirma ?? b.firma?.fechaFirma ?? 0).getTime() -
      new Date(a.contrafirma?.fechaFirma ?? a.firma?.fechaFirma ?? 0).getTime()
  )[0];
  const responsable = (ultimo?.contrafirma?.solicitadoPor ?? ultimo?.revisadoPor) as Types.ObjectId | undefined;
  const id = responsable && typeof responsable === 'object' && '_id' in responsable ? (responsable as { _id: Types.ObjectId })._id : responsable;

  patient.estado = 'aprobado';
  patient.activadoPor = id;
  patient.fechaActivacion = new Date();
  patient.motivoSuspension = undefined;
  patient.historialEstados.push({
    estado: 'aprobado',
    fecha: new Date(),
    usuario: id,
    motivo: 'Activado al completar el registro: documentos aprobados y firmas validadas por el dispensario',
  });
  return true;
}

function antesDeGuardar(patient: IPatient): void {
  const avisos: NonNullable<Locales['avisos']> = [];
  const nombre = `${patient.nombre} ${patient.apellido}`.trim();
  const id = patient._id as Types.ObjectId;
  const alPaciente = (aviso: Omit<Aviso, 'paciente'>) => avisos.push({ paraPaciente: true, aviso: { ...aviso, paciente: id } });
  const alPersonal = (aviso: Omit<Aviso, 'paciente'>) => avisos.push({ paraPaciente: false, aviso: { ...aviso, paciente: id } });

  // Avisos por documento: rechazos (al paciente) y firmas del paciente que esperan validación (al personal).
  const previos = locales(patient).docsPrevios ?? new Map<string, EstadoDoc>();
  for (const d of patient.documentos ?? []) {
    const antes = previos.get(String(d._id));
    if (d.estado === 'rechazado' && antes && antes.estado !== 'rechazado') {
      const firmable = documentosPorEtapa().firma.some((r) => r.tipo === d.tipo);
      alPaciente({
        tipo: 'documento_rechazado',
        titulo: `Tu ${etiqueta(d.tipo).toLowerCase()} fue rechazado`,
        mensaje:
          `${d.observaciones ? `Motivo: ${d.observaciones}. ` : ''}` +
          (firmable
            ? 'Revisa el documento y fírmalo de nuevo desde Mi perfil.'
            : 'Sube una nueva versión desde Mi perfil para continuar con tu registro.'),
        enlace: '/portal/perfil',
      });
    }
    if (d.firma?.estado === 'firmado' && antes && antes.firma !== 'firmado' && tipoRequiereContrafirma(d.tipo)) {
      alPersonal({
        tipo: 'firma_por_validar',
        titulo: `${nombre} firmó su ${etiqueta(d.tipo).toLowerCase()}`,
        mensaje: 'El documento espera la validación y contrafirma de un responsable del dispensario.',
        enlace: '/validacion-firmas',
      });
    }
  }

  let etapa = calcularEtapa(patient);
  if (activarSiCompleto(patient, etapa)) etapa = 'activo';
  const anterior = patient.etapaRegistro;
  patient.etapaRegistro = etapa;

  // Fichas que existían antes de las etapas: se calcula su etapa sin avisar.
  if (anterior !== etapa && (anterior || patient.isNew)) {
    const { ingreso, firma } = documentosPorEtapa();
    const subir = lista(ingreso.map((r) => r.label.toLowerCase()));
    const firmar = lista(firma.map((r) => r.label.toLowerCase()));

    switch (etapa) {
      case 'documentos':
        // Bienvenida solo a quien se registró (las fichas creadas por el personal aún no tienen cuenta).
        if (patient.isNew && patient.usuario) {
          alPaciente({
            tipo: 'registro_documentos',
            titulo: 'Bienvenido a Dispensapp: etapa 1 de 3',
            mensaje: `Para comenzar, sube tu ${subir} en Mi perfil. Después el dispensario los revisará.`,
            enlace: '/portal/perfil',
          });
        }
        // Si volvió desde la revisión es porque se rechazó un documento: ya se avisó con el motivo.
        break;
      case 'revision':
        alPaciente({
          tipo: 'registro_revision',
          titulo: 'Recibimos tus documentos: etapa 2 de 3',
          mensaje: `El dispensario está revisando tu ${subir}. Te avisaremos cuando puedas firmar.`,
          enlace: '/portal/perfil',
        });
        alPersonal({
          tipo: 'registro_revision',
          titulo: `${nombre} cargó sus documentos`,
          mensaje: `Revisa su ${subir} y registra lo que autoriza la receta para que pase a firmar.`,
          enlace: '/validacion-firmas',
        });
        break;
      case 'firma':
        if (anterior === 'documentos' || anterior === 'revision') {
          alPaciente({
            tipo: 'registro_firma',
            titulo: 'Documentos aprobados: etapa 3 de 3',
            mensaje: `El dispensario aprobó tus documentos. Ahora revisa y firma electrónicamente tu ${firmar} en Mi perfil.`,
            enlace: '/portal/perfil',
          });
        }
        break;
      case 'validacion':
        alPaciente({
          tipo: 'registro_validacion',
          titulo: 'Firmaste tus documentos',
          mensaje: 'El dispensario está validando tus firmas. Cuando termine, tu cuenta quedará activa.',
          enlace: '/portal',
        });
        break;
      case 'activacion':
        alPersonal({
          tipo: 'registro_activacion',
          titulo: `${nombre} completó su registro`,
          mensaje: 'Tiene sus documentos en regla. Falta que un administrador lo active desde su ficha.',
          enlace: `/pacientes/${id}`,
        });
        break;
      case 'activo':
        alPaciente(
          anterior === 'suspendido'
            ? {
                tipo: 'cuenta_reactivada',
                titulo: 'Tu cuenta fue reactivada',
                mensaje: 'Ya puedes volver a solicitar dispensaciones.',
                enlace: '/portal',
              }
            : {
                tipo: 'cuenta_activa',
                titulo: '¡Tu cuenta está activa!',
                mensaje: 'Completaste tu registro. Ya puedes solicitar dispensaciones en tu dispensario.',
                enlace: '/portal',
              }
        );
        break;
      case 'suspendido':
        alPaciente(
          patient.motivoSuspension === 'receta_vencida'
            ? {
                tipo: 'cuenta_suspendida',
                titulo: 'Tu receta venció',
                mensaje: 'Tu cuenta quedó suspendida. Sube una receta nueva en Mi perfil; cuando el dispensario la apruebe, se reactiva.',
                enlace: '/portal/perfil',
              }
            : {
                tipo: 'cuenta_suspendida',
                titulo: 'Tu cuenta fue suspendida',
                mensaje: 'Contacta al dispensario para más información.',
                enlace: '/portal',
              }
        );
        break;
      case 'rechazado': {
        const motivo = patient.historialEstados?.at(-1)?.motivo;
        alPaciente({
          tipo: 'registro_rechazado',
          titulo: 'Tu registro fue rechazado',
          mensaje: `${motivo ? `Motivo: ${motivo}. ` : ''}Contacta al dispensario para más información.`,
          enlace: '/portal',
        });
        break;
      }
    }
  }

  locales(patient).avisos = avisos;
}

function despuesDeGuardar(patient: IPatient): void {
  const avisos = locales(patient).avisos ?? [];
  locales(patient).avisos = [];
  recordarEstadoDocumentos(patient);
  if (avisos.length === 0) return;

  void (async () => {
    const personal = avisos.some((a) => !a.paraPaciente) ? await personalDelPaciente(patient.sucursal) : [];
    for (const { paraPaciente, aviso } of avisos) {
      await notificar(paraPaciente ? [{ usuario: patient.usuario, email: patient.email }] : personal, aviso);
    }
  })().catch((err) => console.error('[etapas] Error al enviar avisos:', (err as Error).message));
}

ganchosPaciente.alCargar = recordarEstadoDocumentos;
ganchosPaciente.antesDeGuardar = antesDeGuardar;
ganchosPaciente.despuesDeGuardar = despuesDeGuardar;

/** Calcula y guarda la etapa de las fichas que aún no la tienen (sin avisar). Se llama al arrancar. */
export async function inicializarEtapas(): Promise<void> {
  const sinEtapa = await Patient.find({ etapaRegistro: { $exists: false } }).select('estado documentos');
  for (const p of sinEtapa) {
    await Patient.updateOne({ _id: p._id }, { $set: { etapaRegistro: calcularEtapa(p) } });
  }
  if (sinEtapa.length) console.log(`[etapas] Etapa calculada para ${sinEtapa.length} ficha(s) existente(s).`);
}
