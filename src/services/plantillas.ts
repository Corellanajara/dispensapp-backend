import PDFDocument from 'pdfkit';
import { Types } from 'mongoose';
import { PlantillaDocumento } from '../models/PlantillaDocumento';
import { IPatient } from '../models/Patient';
import { DOCUMENT_TYPE_LABELS, TIPOS_GENERADOS, TipoGenerado } from '../config/documentos';

/**
 * Reglamento interno y contrato generados por la plataforma.
 *
 * El administrador escribe el texto con variables como {{paciente_nombre}}; al generar el documento
 * de un paciente se reemplazan por sus datos y se arma un PDF listo para firmar.
 *
 * Formato del texto (simple a propósito):
 *   # Título          → título centrado
 *   ## Subtítulo      → subtítulo
 *   - elemento        → viñeta
 *   **texto**         → negrita
 *   línea en blanco   → nuevo párrafo
 */

// ─── Variables ─────────────────────────────────────────────

export interface VariablePlantilla {
  clave: string;
  descripcion: string;
  ejemplo: string;
}

export const VARIABLES: VariablePlantilla[] = [
  { clave: 'paciente_nombre', descripcion: 'Nombre completo del paciente', ejemplo: 'Christian Díaz' },
  { clave: 'paciente_rut', descripcion: 'RUT del paciente', ejemplo: '13.241.708-3' },
  { clave: 'paciente_fecha_nacimiento', descripcion: 'Fecha de nacimiento', ejemplo: '10 de mayo de 1996' },
  { clave: 'paciente_direccion', descripcion: 'Dirección completa', ejemplo: 'Av. Providencia 1234, Providencia, Santiago' },
  { clave: 'paciente_comuna', descripcion: 'Comuna del paciente', ejemplo: 'Providencia' },
  { clave: 'paciente_telefono', descripcion: 'Teléfono', ejemplo: '+56 9 1234 5678' },
  { clave: 'paciente_email', descripcion: 'Correo', ejemplo: 'paciente@correo.cl' },
  { clave: 'medico_tratante', descripcion: 'Médico tratante', ejemplo: 'Dr. Juan Pérez' },
  { clave: 'dispensario_nombre', descripcion: 'Nombre del dispensario', ejemplo: 'Dispensario Central' },
  { clave: 'dispensario_direccion', descripcion: 'Dirección del dispensario', ejemplo: 'Los Leones 456, Providencia, Santiago' },
  { clave: 'dispensario_ciudad', descripcion: 'Ciudad del dispensario', ejemplo: 'Santiago' },
  { clave: 'fecha', descripcion: 'Fecha en que se genera el documento', ejemplo: '22 de noviembre de 2026' },
];

const CLAVES = new Set(VARIABLES.map((v) => v.clave));
const PATRON_VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type DatosPlantilla = Record<string, string>;

/** Variables escritas en el texto que no existen (para avisar al guardar). */
export function variablesDesconocidas(texto: string): string[] {
  const malas = new Set<string>();
  for (const m of texto.matchAll(PATRON_VARIABLE)) if (!CLAVES.has(m[1])) malas.add(m[1]);
  return [...malas];
}

export function reemplazarVariables(texto: string, datos: DatosPlantilla): string {
  // Los datos no pueden activar negritas ni otras marcas del formato.
  return texto.replace(PATRON_VARIABLE, (todo, clave: string) =>
    clave in datos ? String(datos[clave] ?? '').replace(/\*\*/g, '') : todo
  );
}

function fechaLarga(fecha: Date | string | undefined): string {
  if (!fecha) return '';
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Santiago' });
}

function fechaNacimiento(fecha: Date | string | undefined): string {
  if (!fecha) return '';
  // Se guarda como medianoche UTC: se lee en UTC para no correr el día.
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** RUT con puntos y guion: 13241708-3 → 13.241.708-3. */
function rutConPuntos(rut: string): string {
  const limpio = String(rut ?? '').replace(/[^0-9kK]/g, '').toUpperCase();
  if (limpio.length < 2) return rut;
  const cuerpo = limpio.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cuerpo}-${limpio.slice(-1)}`;
}

interface SucursalPoblada {
  nombre?: string;
  direccion?: { calle?: string; numero?: string; comuna?: string; ciudad?: string };
}

function direccionTexto(d?: { calle?: string; numero?: string; comuna?: string; ciudad?: string }): string {
  if (!d) return '';
  const calle = [d.calle, d.numero].filter(Boolean).join(' ');
  return [calle, d.comuna, d.ciudad].filter(Boolean).join(', ');
}

/** Datos del paciente para la plantilla. La sucursal debe venir poblada (nombre y dirección). */
export function datosDePaciente(patient: IPatient, fecha = new Date()): DatosPlantilla {
  const suc = (patient.sucursal && typeof patient.sucursal === 'object' && 'nombre' in patient.sucursal
    ? patient.sucursal
    : null) as SucursalPoblada | null;
  return {
    paciente_nombre: `${patient.nombre} ${patient.apellido}`.trim(),
    paciente_rut: rutConPuntos(patient.rut),
    paciente_fecha_nacimiento: fechaNacimiento(patient.fechaNacimiento),
    paciente_direccion: direccionTexto(patient.direccion),
    paciente_comuna: patient.direccion?.comuna ?? '',
    paciente_telefono: patient.telefono ?? '',
    paciente_email: patient.email ?? '',
    medico_tratante: patient.medicoTratante?.nombre ?? '',
    dispensario_nombre: suc?.nombre ?? 'el dispensario',
    dispensario_direccion: direccionTexto(suc?.direccion),
    dispensario_ciudad: suc?.direccion?.ciudad ?? 'Santiago',
    fecha: fechaLarga(fecha),
  };
}

/** Datos inventados para la vista previa del administrador. */
export function datosDeEjemplo(): DatosPlantilla {
  const datos: DatosPlantilla = {};
  for (const v of VARIABLES) datos[v.clave] = v.ejemplo;
  datos.fecha = fechaLarga(new Date());
  return datos;
}

// ─── Textos de ejemplo ─────────────────────────────────────

export const PLANTILLAS_POR_DEFECTO: Record<TipoGenerado, { titulo: string; contenido: string }> = {
  reglamento_interno: {
    titulo: 'Reglamento interno',
    contenido: `# REGLAMENTO INTERNO
## {{dispensario_nombre}}

En {{dispensario_ciudad}}, a {{fecha}}, **{{paciente_nombre}}**, RUT **{{paciente_rut}}**, con domicilio en {{paciente_direccion}}, declara conocer y aceptar el presente Reglamento Interno de **{{dispensario_nombre}}**, ubicado en {{dispensario_direccion}}.

## 1. Objeto
Este reglamento regula la relación entre el dispensario y sus pacientes inscritos, el acceso a productos derivados de cannabis de uso medicinal y las obligaciones de ambas partes.

## 2. Requisitos de inscripción
- Contar con receta médica vigente emitida por su médico tratante, {{medico_tratante}}.
- Presentar su certificado de antecedentes.
- Firmar electrónicamente este reglamento y el mandato o contrato con el dispensario.
- Mantener actualizados sus datos de contacto: teléfono {{paciente_telefono}} y correo {{paciente_email}}.

## 3. Uso personal y exclusivo
Los productos que reciba el paciente son para su uso personal y exclusivo, según la indicación de su médico tratante. Está prohibido venderlos, cederlos o entregarlos a terceros.

## 4. Retiro de productos
El retiro se hace presencialmente en el dispensario, previa identificación, dentro del límite mensual que el dispensario determine según la receta vigente. Cada entrega queda registrada en una nota de dispensación.

## 5. Vigencia de la receta
Si la receta vence, la cuenta del paciente queda suspendida hasta que presente una nueva receta y el dispensario la apruebe.

## 6. Confidencialidad y datos personales
El dispensario trata los datos personales y de salud del paciente de forma confidencial, solo para los fines de este reglamento y conforme a la Ley N° 19.628 sobre protección de la vida privada.

## 7. Incumplimientos
El incumplimiento de este reglamento puede significar la suspensión o el término de la inscripción del paciente, previa comunicación por escrito.

## 8. Aceptación
Al firmar electrónicamente este documento, el paciente declara haberlo leído y aceptarlo en todas sus partes.`,
  },
  mandato_contrato: {
    titulo: 'Mandato y contrato',
    contenido: `# MANDATO Y CONTRATO
## {{dispensario_nombre}}

En {{dispensario_ciudad}}, a {{fecha}}, comparecen:

- **{{paciente_nombre}}**, RUT {{paciente_rut}}, nacido(a) el {{paciente_fecha_nacimiento}}, con domicilio en {{paciente_direccion}}, en adelante "el paciente" o "el mandante"; y
- **{{dispensario_nombre}}**, con domicilio en {{dispensario_direccion}}, en adelante "el dispensario" o "el mandatario".

Las partes acuerdan lo siguiente:

## Primero: Mandato
El paciente encarga al dispensario, que acepta, el cultivo, la producción, el almacenamiento y la custodia de cannabis y sus derivados destinados exclusivamente al tratamiento indicado por su médico tratante, {{medico_tratante}}, en las cantidades que señale su receta médica vigente.

## Segundo: Obligaciones del dispensario
- Cultivar y producir con trazabilidad de cada lote.
- Entregar al paciente solo productos con trazabilidad registrada, dentro de los límites de su receta vigente.
- Resguardar la confidencialidad de los datos del paciente.

## Tercero: Obligaciones del paciente
- Mantener vigente su receta médica y actualizados sus datos de contacto.
- Destinar los productos únicamente a su uso personal.
- Cumplir el reglamento interno del dispensario, que declara conocer.

## Cuarto: Sin fines de lucro
Este mandato no tiene fines comerciales. Las entregas al paciente no constituyen una compraventa.

## Quinto: Duración y término
Este contrato rige desde su firma y tiene duración indefinida. Cualquiera de las partes puede ponerle término avisando a la otra por escrito, con al menos 30 días de anticipación. Si la receta del paciente vence, las entregas se suspenden mientras no presente una nueva.

## Sexto: Firma electrónica
Las partes firman este documento con firma electrónica avanzada, conforme a la Ley N° 19.799.`,
  },
};

// ─── Plantillas guardadas ──────────────────────────────────

export interface PlantillaVigente {
  tipo: TipoGenerado;
  etiqueta: string;
  titulo: string;
  contenido: string;
  /** 0 = nunca se ha guardado: se usa el texto de ejemplo. */
  version: number;
  actualizadoPor?: unknown;
  updatedAt?: Date;
}

export async function obtenerPlantilla(tipo: TipoGenerado): Promise<PlantillaVigente> {
  const doc = await PlantillaDocumento.findOne({ tipo }).populate('actualizadoPor', 'nombre apellido');
  const base = PLANTILLAS_POR_DEFECTO[tipo];
  return {
    tipo,
    etiqueta: DOCUMENT_TYPE_LABELS[tipo],
    titulo: doc?.titulo ?? base.titulo,
    contenido: doc?.contenido ?? base.contenido,
    version: doc?.version ?? 0,
    actualizadoPor: doc?.actualizadoPor,
    updatedAt: doc?.updatedAt,
  };
}

export async function listarPlantillas(): Promise<PlantillaVigente[]> {
  return Promise.all(TIPOS_GENERADOS.map((t) => obtenerPlantilla(t)));
}

export async function guardarPlantilla(
  tipo: TipoGenerado,
  cambios: { titulo: string; contenido: string },
  usuario: Types.ObjectId
): Promise<PlantillaVigente> {
  const doc = await PlantillaDocumento.findOne({ tipo });
  if (doc) {
    if (doc.titulo !== cambios.titulo || doc.contenido !== cambios.contenido) {
      doc.titulo = cambios.titulo;
      doc.contenido = cambios.contenido;
      doc.version += 1;
      doc.actualizadoPor = usuario;
      await doc.save();
    }
  } else {
    await PlantillaDocumento.create({ tipo, ...cambios, version: 1, actualizadoPor: usuario });
  }
  return obtenerPlantilla(tipo);
}

// ─── PDF ───────────────────────────────────────────────────

/** Hoja carta en puntos (1/72"), igual que las coordenadas de la estampa de Signapis. */
const ANCHO = 612;
const ALTO = 792;
const MARGEN_X = 64;
const MARGEN_SUP = 60;
const MARGEN_INF = 64;

/**
 * Zona de firmas en la última página. Signapis mide la posición desde la esquina superior izquierda:
 * las estampas van en y = 645, la del paciente a la izquierda y la del responsable 220 pt a la derecha
 * (ver posicionContrafirma en services/firmas.ts). Bajo los nombres la hoja queda libre para las estampas.
 */
const ZONA_FIRMAS = 585;
export const POSICION_FIRMA_GENERADA = { x: 72, y: 645 };

export interface PdfGenerado {
  buffer: Buffer;
  /** Dónde va la estampa del paciente. */
  posicionFirma: { pagina: number; x: number; y: number };
  paginas: number;
}

interface OpcionesPdf {
  titulo: string;
  contenido: string;
  datos: DatosPlantilla;
  version: number;
  /** Marca de agua para las vistas previas. */
  borrador?: boolean;
}

type Doc = InstanceType<typeof PDFDocument>;

/** Escribe un texto con **negritas** en la posición actual. */
function textoConNegritas(doc: Doc, texto: string, x: number, ancho: number, opts: { align?: 'left' | 'justify' | 'center' } = {}) {
  const partes = texto.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== '');
  if (partes.length === 0) return;
  partes.forEach((parte, i) => {
    const negrita = parte.startsWith('**') && parte.endsWith('**') && parte.length > 4;
    doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica');
    const contenido = negrita ? parte.slice(2, -2) : parte;
    const continuar = i < partes.length - 1;
    if (i === 0) doc.text(contenido, x, doc.y, { width: ancho, align: opts.align ?? 'justify', lineGap: 2.5, continued: continuar });
    else doc.text(contenido, { continued: continuar });
  });
  doc.font('Helvetica');
}

export function generarPdf(opts: OpcionesPdf): Promise<PdfGenerado> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGEN_SUP, bottom: MARGEN_INF, left: MARGEN_X, right: MARGEN_X },
      bufferPages: true,
      info: { Title: opts.titulo, Creator: 'Dispensapp', Producer: 'Dispensapp' },
    });
    const partes: Buffer[] = [];
    doc.on('data', (c: Buffer) => partes.push(c));
    doc.on('error', reject);

    const ancho = ANCHO - 2 * MARGEN_X;
    const texto = reemplazarVariables(opts.contenido, opts.datos);
    const bloques = texto.replace(/\r\n/g, '\n').split('\n');

    doc.fillColor('#111111').fontSize(10.5);
    let enParrafo: string[] = [];

    const cerrarParrafo = () => {
      if (enParrafo.length === 0) return;
      doc.fontSize(10.5).fillColor('#111111');
      textoConNegritas(doc, enParrafo.join(' '), MARGEN_X, ancho);
      doc.moveDown(0.6);
      enParrafo = [];
    };

    for (const linea of bloques) {
      const l = linea.trim();
      if (l === '') {
        cerrarParrafo();
        continue;
      }
      if (l.startsWith('# ')) {
        cerrarParrafo();
        doc.font('Helvetica-Bold').fontSize(15).fillColor('#111111');
        doc.text(l.slice(2).replace(/\*\*/g, ''), MARGEN_X, doc.y, { width: ancho, align: 'center' });
        doc.moveDown(0.3);
        continue;
      }
      if (l.startsWith('## ')) {
        cerrarParrafo();
        // Un subtítulo no queda solo al final de la hoja.
        if (doc.y > ALTO - MARGEN_INF - 60) doc.addPage();
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111');
        doc.text(l.slice(3).replace(/\*\*/g, ''), MARGEN_X, doc.y, { width: ancho });
        doc.moveDown(0.35);
        doc.font('Helvetica');
        continue;
      }
      if (l.startsWith('- ') || l.startsWith('* ')) {
        cerrarParrafo();
        doc.fontSize(10.5).fillColor('#111111').font('Helvetica');
        const y = doc.y;
        doc.text('•', MARGEN_X + 6, y, { width: 10 });
        doc.y = y;
        textoConNegritas(doc, l.slice(2), MARGEN_X + 20, ancho - 20, { align: 'left' });
        doc.moveDown(0.35);
        continue;
      }
      enParrafo.push(l);
    }
    cerrarParrafo();

    // Bloque de firmas: en la última hoja, con la parte de abajo libre para las estampas.
    if (doc.y > ZONA_FIRMAS - 16) doc.addPage();
    const pagina = doc.bufferedPageRange().count;
    const col = 220;
    const x1 = POSICION_FIRMA_GENERADA.x;
    const x2 = x1 + col;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111');
    doc.text('Firmas', MARGEN_X, ZONA_FIRMAS, { width: ancho });
    doc.font('Helvetica').fontSize(8.5).fillColor('#555555');
    doc.text(
      'Este documento se firma con firma electrónica avanzada. Las firmas aparecen bajo cada nombre.',
      MARGEN_X,
      ZONA_FIRMAS + 16,
      { width: ancho }
    );
    const yNombres = ZONA_FIRMAS + 34;
    doc.moveTo(x1, yNombres - 5).lineTo(x1 + col - 24, yNombres - 5).lineWidth(0.5).strokeColor('#999999').stroke();
    doc.moveTo(x2, yNombres - 5).lineTo(x2 + col - 24, yNombres - 5).stroke();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111111');
    doc.text(opts.datos.paciente_nombre ?? 'Paciente', x1, yNombres, { width: col - 24, lineBreak: false });
    doc.text(opts.datos.dispensario_nombre ?? 'Dispensario', x2, yNombres, { width: col - 24, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#555555');
    doc.text(`Paciente · RUT ${opts.datos.paciente_rut ?? ''}`, x1, yNombres + 11, { width: col - 24, lineBreak: false });
    doc.text('Validación del dispensario', x2, yNombres + 11, { width: col - 24, lineBreak: false });

    // Encabezado, pie y marca de agua en cada hoja.
    const rango = doc.bufferedPageRange();
    for (let i = 0; i < rango.count; i++) {
      doc.switchToPage(rango.start + i);
      const mb = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor('#888888');
      doc.text(`${opts.datos.dispensario_nombre ?? ''} · ${opts.titulo}`, MARGEN_X, 28, { width: ancho, align: 'left', lineBreak: false });
      doc.text(`Página ${i + 1} de ${rango.count}`, MARGEN_X, 28, { width: ancho, align: 'right', lineBreak: false });
      doc.text(
        `Generado por Dispensapp el ${opts.datos.fecha ?? ''}${opts.version > 0 ? ` · versión ${opts.version} del texto` : ' · texto de ejemplo'}`,
        MARGEN_X,
        ALTO - 22,
        { width: ancho, align: 'center', lineBreak: false }
      );
      if (opts.borrador) {
        doc.save();
        doc.rotate(-35, { origin: [ANCHO / 2, ALTO / 2] });
        doc.font('Helvetica-Bold').fontSize(72).fillColor('#cc0000').opacity(0.08);
        doc.text('VISTA PREVIA', 0, ALTO / 2 - 40, { width: ANCHO, align: 'center', lineBreak: false });
        doc.restore();
        doc.opacity(1);
      }
      doc.page.margins.bottom = mb;
    }

    doc.on('end', () =>
      resolve({
        buffer: Buffer.concat(partes),
        posicionFirma: { pagina, ...POSICION_FIRMA_GENERADA },
        paginas: rango.count,
      })
    );
    doc.end();
  });
}

/** Genera el PDF de un paciente con la plantilla vigente. La sucursal del paciente debe venir poblada. */
export async function generarDocumentoPaciente(tipo: TipoGenerado, patient: IPatient) {
  const plantilla = await obtenerPlantilla(tipo);
  const pdf = await generarPdf({
    titulo: plantilla.titulo,
    contenido: plantilla.contenido,
    datos: datosDePaciente(patient),
    version: plantilla.version,
  });
  return { ...pdf, plantilla };
}
