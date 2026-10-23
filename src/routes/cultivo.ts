import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose, { Types } from 'mongoose';
import { EspacioCultivo, Cosecha, IEspacioCultivo } from '../models/Cultivo';
import { Patient } from '../models/Patient';
import { Product } from '../models/Product';
import { Ubicacion } from '../models/Ubicacion';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, getSucursalFilter, canAccessSucursal } from '../middleware/sucursal';
import { auditLog } from '../middleware/audit';
import { generateCode, generateLotCode, generateQRToken } from '../utils/helpers';
import { ingresarStock, registrarMovimiento } from '../services/stock';
import { registrarAuditoria } from '../services/audit';

/**
 * Cultivo: espacios cedidos a pacientes, su código QR y las cosechas.
 * Paciente → Espacio cedido (m²) → Flor → QR → Ubicación → Cosecha (lote) → Inventario.
 */
const router = Router();

const STAFF = ['admin', 'operador', 'cultivo'] as const;

async function cargarEspacio(req: AuthRequest, res: Response, id: string): Promise<IEspacioCultivo | null> {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ message: 'ID inválido.' });
    return null;
  }
  const espacio = await EspacioCultivo.findById(id);
  if (!espacio) {
    res.status(404).json({ message: 'Espacio de cultivo no encontrado.' });
    return null;
  }
  if (!canAccessSucursal(req.user, espacio.sucursal)) {
    res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
    return null;
  }
  return espacio;
}

const POPULATE_ESPACIO = [
  { path: 'paciente', select: 'nombre apellido rut estado' },
  { path: 'ubicacion', select: 'nombre codigo tipo' },
  { path: 'sucursal', select: 'nombre codigo' },
  { path: 'creadoPor', select: 'nombre apellido' },
];

// ─── Espacios ──────────────────────────────────────────────

// GET /api/cultivo/espacios
router.get(
  '/espacios',
  authenticate,
  authorize(...STAFF),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { paciente, estado, ubicacion, search } = req.query as Record<string, string>;
      const filter: Record<string, unknown> = { ...getSucursalFilter(req) };
      if (paciente) filter.paciente = paciente;
      if (estado) filter.estado = estado;
      if (ubicacion) filter.ubicacion = ubicacion;
      if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [{ codigo: { $regex: escaped, $options: 'i' } }, { flor: { $regex: escaped, $options: 'i' } }];
      }

      const espacios = await EspacioCultivo.find(filter).populate(POPULATE_ESPACIO).sort({ createdAt: -1 });
      res.json(espacios);
    } catch (error) {
      console.error('Get espacios error:', error);
      res.status(500).json({ message: 'Error al obtener espacios de cultivo.' });
    }
  }
);

// POST /api/cultivo/espacios — ceder un espacio a un paciente activo
router.post(
  '/espacios',
  authenticate,
  authorize(...STAFF),
  resolveSucursal(),
  auditLog('crear', 'espacio_cultivo'),
  [
    body('paciente').isMongoId().withMessage('Paciente inválido'),
    body('ubicacion').isMongoId().withMessage('Ubicación inválida'),
    body('metrosCuadrados').isFloat({ gt: 0 }).withMessage('Los metros cuadrados deben ser mayores a 0'),
    body('flor').notEmpty().withMessage('Indica el tipo de flor'),
    body('fechaInicio').optional({ values: 'falsy' }).isISO8601(),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }
    try {
      if (!req.sucursalId) {
        res.status(400).json({ message: 'Selecciona la sucursal.' });
        return;
      }
      const patient = await Patient.findById(req.body.paciente);
      if (!patient) {
        res.status(404).json({ message: 'Paciente no encontrado.' });
        return;
      }
      if (String(patient.sucursal) !== String(req.sucursalId)) {
        res.status(400).json({ message: 'El paciente no pertenece a esta sucursal.' });
        return;
      }
      if (patient.estado !== 'aprobado') {
        res.status(400).json({ message: 'Solo se pueden ceder espacios a pacientes activos.' });
        return;
      }
      const ubicacion = await Ubicacion.findOne({ _id: req.body.ubicacion, sucursal: req.sucursalId, activo: true });
      if (!ubicacion || ubicacion.tipo !== 'sala_cultivo') {
        res.status(400).json({ message: 'La ubicación debe ser una sala de cultivo activa de esta sucursal.' });
        return;
      }

      const espacio = await EspacioCultivo.create({
        sucursal: req.sucursalId,
        paciente: patient._id,
        ubicacion: ubicacion._id,
        codigo: generateCode('ESP'),
        codigoQR: generateQRToken(),
        metrosCuadrados: req.body.metrosCuadrados,
        flor: req.body.flor,
        fechaInicio: req.body.fechaInicio || new Date(),
        observaciones: req.body.observaciones,
        creadoPor: req.user!._id,
      });
      await espacio.populate(POPULATE_ESPACIO);
      res.status(201).json(espacio);
    } catch (error) {
      console.error('Create espacio error:', error);
      res.status(500).json({ message: 'Error al crear espacio de cultivo.' });
    }
  }
);

// GET /api/cultivo/qr/:codigoQR — lo que abre el QR al escanearlo
router.get(
  '/qr/:codigoQR',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const espacio = await EspacioCultivo.findOne({ codigoQR: String(req.params.codigoQR) }).populate(POPULATE_ESPACIO);
      if (!espacio) {
        res.status(404).json({ message: 'Código QR no reconocido.' });
        return;
      }
      const sucursalId = (espacio.sucursal as unknown as { _id: Types.ObjectId })._id;
      if (!canAccessSucursal(req.user, sucursalId)) {
        res.status(403).json({ message: 'Este espacio pertenece a otra sucursal.' });
        return;
      }

      const cosechas = await Cosecha.find({ espacio: espacio._id })
        .populate('producto', 'nombre')
        .populate('ubicacionDestino', 'nombre codigo')
        .sort({ fecha: -1 });

      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'escanear_qr',
        entidad: 'espacio_cultivo',
        entidadId: espacio._id as Types.ObjectId,
        sucursal: sucursalId,
      });

      res.json({ espacio, cosechas });
    } catch (error) {
      console.error('Scan QR error:', error);
      res.status(500).json({ message: 'Error al leer el código QR.' });
    }
  }
);

// GET /api/cultivo/espacios/:id
router.get(
  '/espacios/:id',
  authenticate,
  authorize(...STAFF),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const espacio = await cargarEspacio(req, res, String(req.params.id));
      if (!espacio) return;
      await espacio.populate(POPULATE_ESPACIO);
      const cosechas = await Cosecha.find({ espacio: espacio._id })
        .populate('producto', 'nombre')
        .populate('ubicacionDestino', 'nombre codigo')
        .populate('responsable', 'nombre apellido')
        .sort({ fecha: -1 });
      res.json({ espacio, cosechas });
    } catch (error) {
      console.error('Get espacio error:', error);
      res.status(500).json({ message: 'Error al obtener espacio.' });
    }
  }
);

// PUT /api/cultivo/espacios/:id — cambiar flor, m², ubicación u observaciones (el QR se mantiene)
router.put(
  '/espacios/:id',
  authenticate,
  authorize(...STAFF),
  auditLog('actualizar', 'espacio_cultivo'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const espacio = await cargarEspacio(req, res, String(req.params.id));
      if (!espacio) return;
      if (espacio.estado !== 'activo') {
        res.status(400).json({ message: 'El espacio está cerrado.' });
        return;
      }
      if (req.body.ubicacion) {
        const u = await Ubicacion.findOne({ _id: req.body.ubicacion, sucursal: espacio.sucursal, activo: true });
        if (!u || u.tipo !== 'sala_cultivo') {
          res.status(400).json({ message: 'La ubicación debe ser una sala de cultivo activa de la misma sucursal.' });
          return;
        }
        espacio.ubicacion = u._id as Types.ObjectId;
      }
      if (req.body.flor !== undefined) espacio.flor = req.body.flor;
      if (req.body.metrosCuadrados !== undefined) espacio.metrosCuadrados = Number(req.body.metrosCuadrados);
      if (req.body.observaciones !== undefined) espacio.observaciones = req.body.observaciones;
      await espacio.save();
      await espacio.populate(POPULATE_ESPACIO);
      res.json(espacio);
    } catch (error) {
      console.error('Update espacio error:', error);
      res.status(500).json({ message: 'Error al actualizar espacio.' });
    }
  }
);

// PATCH /api/cultivo/espacios/:id/cerrar
router.patch(
  '/espacios/:id/cerrar',
  authenticate,
  authorize(...STAFF),
  auditLog('cerrar', 'espacio_cultivo'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const espacio = await cargarEspacio(req, res, String(req.params.id));
      if (!espacio) return;
      espacio.estado = 'cerrado';
      espacio.fechaCierre = new Date();
      if (req.body.observaciones) espacio.observaciones = req.body.observaciones;
      await espacio.save();
      await espacio.populate(POPULATE_ESPACIO);
      res.json(espacio);
    } catch (error) {
      console.error('Close espacio error:', error);
      res.status(500).json({ message: 'Error al cerrar espacio.' });
    }
  }
);

// POST /api/cultivo/espacios/:id/regenerar-qr — invalida el QR anterior (ej. si se perdió la etiqueta)
router.post(
  '/espacios/:id/regenerar-qr',
  authenticate,
  authorize('admin'),
  auditLog('regenerar_qr', 'espacio_cultivo'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const espacio = await cargarEspacio(req, res, String(req.params.id));
      if (!espacio) return;
      espacio.codigoQR = generateQRToken();
      await espacio.save();
      await espacio.populate(POPULATE_ESPACIO);
      res.json(espacio);
    } catch (error) {
      console.error('Regenerate QR error:', error);
      res.status(500).json({ message: 'Error al regenerar el QR.' });
    }
  }
);

// ─── Cosechas ──────────────────────────────────────────────

const validarIngreso = [
  body('ingreso.producto').optional().isMongoId().withMessage('Producto inválido'),
  body('ingreso.cantidad').optional().isFloat({ gt: 0 }).withMessage('Cantidad debe ser mayor a 0'),
  body('ingreso.ubicacion').optional({ values: 'falsy' }).isMongoId().withMessage('Ubicación inválida'),
  body('ingreso.fechaVencimiento').optional({ values: 'falsy' }).isISO8601(),
];

/** Ingresa una cosecha a inventario: crea el stock del lote y el movimiento. */
async function ingresarCosecha(
  req: AuthRequest,
  cosecha: InstanceType<typeof Cosecha>,
  ingreso: { producto: string; cantidad: number; ubicacion?: string; fechaVencimiento?: string }
): Promise<string | null> {
  const product = await Product.findOne({ _id: ingreso.producto, activo: true });
  if (!product) return 'Producto no encontrado.';

  let ubicacionId: Types.ObjectId | null = null;
  if (ingreso.ubicacion) {
    const u = await Ubicacion.findOne({ _id: ingreso.ubicacion, sucursal: cosecha.sucursal, activo: true });
    if (!u) return 'La ubicación de destino no pertenece a la sucursal.';
    ubicacionId = u._id as Types.ObjectId;
  }

  const cantidad = Number(ingreso.cantidad);
  const { fila, anterior } = await ingresarStock({
    sucursal: cosecha.sucursal,
    producto: product._id as Types.ObjectId,
    lote: cosecha.lote,
    ubicacion: ubicacionId,
    cosecha: cosecha._id as Types.ObjectId,
    cantidad,
    fechaProduccion: cosecha.fecha,
    fechaVencimiento: ingreso.fechaVencimiento ? new Date(ingreso.fechaVencimiento) : undefined,
  });

  await registrarMovimiento({
    sucursal: cosecha.sucursal,
    producto: product._id as Types.ObjectId,
    tipo: 'cosecha',
    cantidad,
    cantidadAnterior: anterior,
    cantidadNueva: fila.cantidadDisponible,
    lote: cosecha.lote,
    ubicacion: ubicacionId,
    stock: fila._id as Types.ObjectId,
    motivo: `Ingreso de cosecha ${cosecha.lote}`,
    referencia: { tipo: 'cosecha', id: cosecha._id as Types.ObjectId },
    usuario: req.user!._id as Types.ObjectId,
  });

  cosecha.producto = product._id as Types.ObjectId;
  cosecha.cantidadIngresada = cantidad;
  cosecha.ubicacionDestino = ubicacionId || undefined;
  cosecha.estado = 'en_inventario';
  await cosecha.save();
  return null;
}

// GET /api/cultivo/cosechas
router.get(
  '/cosechas',
  authenticate,
  authorize(...STAFF, 'produccion'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { espacio, paciente, estado } = req.query as Record<string, string>;
      const filter: Record<string, unknown> = { ...getSucursalFilter(req) };
      if (espacio) filter.espacio = espacio;
      if (paciente) filter.paciente = paciente;
      if (estado) filter.estado = estado;

      const cosechas = await Cosecha.find(filter)
        .populate('espacio', 'codigo flor')
        .populate('paciente', 'nombre apellido rut')
        .populate('producto', 'nombre tipo')
        .populate('ubicacionDestino', 'nombre codigo')
        .populate('responsable', 'nombre apellido')
        .sort({ fecha: -1 })
        .limit(500);
      res.json(cosechas);
    } catch (error) {
      console.error('Get cosechas error:', error);
      res.status(500).json({ message: 'Error al obtener cosechas.' });
    }
  }
);

// POST /api/cultivo/espacios/:id/cosechas — registrar cosecha (y opcionalmente ingresarla a inventario)
router.post(
  '/espacios/:id/cosechas',
  authenticate,
  authorize(...STAFF),
  auditLog('registrar_cosecha', 'espacio_cultivo'),
  [
    body('fecha').optional({ values: 'falsy' }).isISO8601(),
    body('pesoHumedo').optional({ values: 'falsy' }).isFloat({ min: 0 }),
    body('pesoSeco').optional({ values: 'falsy' }).isFloat({ min: 0 }),
    ...validarIngreso,
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }
    try {
      const espacio = await cargarEspacio(req, res, String(req.params.id));
      if (!espacio) return;

      const cosecha = await Cosecha.create({
        sucursal: espacio.sucursal,
        espacio: espacio._id,
        paciente: espacio.paciente,
        lote: generateLotCode(),
        fecha: req.body.fecha || new Date(),
        pesoHumedo: req.body.pesoHumedo || undefined,
        pesoSeco: req.body.pesoSeco || undefined,
        responsable: req.user!._id,
        observaciones: req.body.observaciones,
      });

      if (req.body.ingreso?.producto && req.body.ingreso?.cantidad) {
        const err = await ingresarCosecha(req, cosecha, req.body.ingreso);
        if (err) {
          res.status(400).json({ message: `Cosecha registrada (${cosecha.lote}), pero no se ingresó: ${err}`, cosecha });
          return;
        }
      }

      await cosecha.populate([
        { path: 'producto', select: 'nombre' },
        { path: 'ubicacionDestino', select: 'nombre codigo' },
      ]);
      res.status(201).json(cosecha);
    } catch (error) {
      console.error('Create cosecha error:', error);
      res.status(500).json({ message: 'Error al registrar cosecha.' });
    }
  }
);

// POST /api/cultivo/cosechas/:id/ingresar — ingresar a inventario una cosecha ya registrada
router.post(
  '/cosechas/:id/ingresar',
  authenticate,
  authorize(...STAFF),
  auditLog('ingresar_cosecha', 'cosecha'),
  [
    body('producto').isMongoId().withMessage('Producto inválido'),
    body('cantidad').isFloat({ gt: 0 }).withMessage('Cantidad debe ser mayor a 0'),
    body('ubicacion').optional({ values: 'falsy' }).isMongoId(),
    body('fechaVencimiento').optional({ values: 'falsy' }).isISO8601(),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }
    try {
      if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
        res.status(400).json({ message: 'ID inválido.' });
        return;
      }
      const cosecha = await Cosecha.findById(req.params.id);
      if (!cosecha) {
        res.status(404).json({ message: 'Cosecha no encontrada.' });
        return;
      }
      if (!canAccessSucursal(req.user, cosecha.sucursal)) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
        return;
      }
      if (cosecha.estado === 'en_inventario') {
        res.status(400).json({ message: 'Esta cosecha ya fue ingresada a inventario.' });
        return;
      }
      const err = await ingresarCosecha(req, cosecha, req.body);
      if (err) {
        res.status(400).json({ message: err });
        return;
      }
      res.json(cosecha);
    } catch (error) {
      console.error('Ingresar cosecha error:', error);
      res.status(500).json({ message: 'Error al ingresar cosecha a inventario.' });
    }
  }
);

export default router;
