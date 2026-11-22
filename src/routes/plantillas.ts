import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { Types } from 'mongoose';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { registrarAuditoria } from '../services/audit';
import { esTipoGenerado } from '../config/documentos';
import {
  VARIABLES,
  PLANTILLAS_POR_DEFECTO,
  listarPlantillas,
  obtenerPlantilla,
  guardarPlantilla,
  variablesDesconocidas,
  generarPdf,
  datosDeEjemplo,
} from '../services/plantillas';

/**
 * Plantillas del reglamento interno y del contrato. Solo el administrador las ve y las edita.
 */
const router = Router();

function tipoValido(req: AuthRequest, res: Response): string | null {
  const tipo = String(req.params.tipo);
  if (!esTipoGenerado(tipo)) {
    res.status(404).json({ message: 'Ese documento no se genera desde una plantilla.' });
    return null;
  }
  return tipo;
}

const validarTexto = [
  body('titulo').isString().trim().isLength({ min: 2, max: 200 }).withMessage('Escribe un título (máximo 200 caracteres)'),
  body('contenido').isString().isLength({ min: 20, max: 60_000 }).withMessage('El texto del documento está vacío o es demasiado largo'),
];

function revisarTexto(req: AuthRequest, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    return false;
  }
  const malas = variablesDesconocidas(`${req.body.titulo}\n${req.body.contenido}`);
  if (malas.length > 0) {
    res.status(400).json({
      message: `Estas variables no existen: ${malas.map((v) => `{{${v}}}`).join(', ')}. Usa las de la lista.`,
    });
    return false;
  }
  return true;
}

// GET /api/plantillas — textos vigentes, variables disponibles y textos de ejemplo
router.get('/', authenticate, authorize('admin'), async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ plantillas: await listarPlantillas(), variables: VARIABLES, porDefecto: PLANTILLAS_POR_DEFECTO });
  } catch (error) {
    console.error('Get plantillas error:', error);
    res.status(500).json({ message: 'Error al cargar las plantillas.' });
  }
});

// PUT /api/plantillas/:tipo — guarda el texto (sube la versión si cambió)
router.put('/:tipo', authenticate, authorize('admin'), validarTexto, async (req: AuthRequest, res: Response): Promise<void> => {
  const tipo = tipoValido(req, res);
  if (!tipo || !revisarTexto(req, res)) return;
  try {
    const antes = await obtenerPlantilla(tipo as never);
    const plantilla = await guardarPlantilla(
      tipo as never,
      { titulo: String(req.body.titulo).trim(), contenido: String(req.body.contenido) },
      req.user!._id as Types.ObjectId
    );
    if (plantilla.version !== antes.version) {
      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'actualizar_plantilla',
        entidad: 'configuracion',
        detalles: { tipo, version: plantilla.version },
      });
    }
    res.json(plantilla);
  } catch (error) {
    console.error('Save plantilla error:', error);
    res.status(500).json({ message: 'Error al guardar la plantilla.' });
  }
});

// POST /api/plantillas/:tipo/vista-previa — PDF con datos de ejemplo (del texto enviado, sin guardarlo)
router.post(
  '/:tipo/vista-previa',
  authenticate,
  authorize('admin'),
  validarTexto,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const tipo = tipoValido(req, res);
    if (!tipo || !revisarTexto(req, res)) return;
    try {
      const actual = await obtenerPlantilla(tipo as never);
      const pdf = await generarPdf({
        titulo: String(req.body.titulo).trim(),
        contenido: String(req.body.contenido),
        datos: datosDeEjemplo(),
        version: actual.version,
        borrador: true,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${tipo}-vista-previa.pdf"`);
      res.send(pdf.buffer);
    } catch (error) {
      console.error('Preview plantilla error:', error);
      res.status(500).json({ message: 'Error al generar la vista previa.' });
    }
  }
);

export default router;
