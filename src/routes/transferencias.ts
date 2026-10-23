import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose, { Types } from 'mongoose';
import { Transferencia, ITransferencia, ITransferenciaItem } from '../models/Transferencia';
import { SucursalStock } from '../models/SucursalStock';
import { Sucursal } from '../models/Sucursal';
import { Ubicacion } from '../models/Ubicacion';
import { Product } from '../models/Product';
import { InventoryMovement } from '../models/Inventory';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, canAccessSucursal } from '../middleware/sucursal';
import { auditLog } from '../middleware/audit';
import { generateCode } from '../utils/helpers';
import { egresarStock, ingresarStock, registrarMovimiento, StockError } from '../services/stock';

/**
 * Transferencias trazables entre ubicaciones (ej. sala o bodega → dispensario).
 * Enviar: el stock sale del origen. Recibir: entra al destino. Anular: vuelve al origen.
 */
const router = Router();

const POPULATE = [
  { path: 'sucursalOrigen', select: 'nombre codigo' },
  { path: 'sucursalDestino', select: 'nombre codigo' },
  { path: 'ubicacionOrigen', select: 'nombre codigo tipo' },
  { path: 'ubicacionDestino', select: 'nombre codigo tipo' },
  { path: 'enviadoPor', select: 'nombre apellido' },
  { path: 'recibidoPor', select: 'nombre apellido' },
  { path: 'anuladoPor', select: 'nombre apellido' },
  { path: 'items.producto', select: 'nombre tipo' },
];

async function cargar(req: AuthRequest, res: Response): Promise<ITransferencia | null> {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
    res.status(400).json({ message: 'ID inválido.' });
    return null;
  }
  const t = await Transferencia.findById(req.params.id);
  if (!t) {
    res.status(404).json({ message: 'Transferencia no encontrada.' });
    return null;
  }
  if (!canAccessSucursal(req.user, t.sucursalOrigen) && !canAccessSucursal(req.user, t.sucursalDestino)) {
    res.status(403).json({ message: 'No tiene acceso a esta transferencia.' });
    return null;
  }
  return t;
}

// GET /api/transferencias
router.get(
  '/',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { estado, page = '1', limit = '20' } = req.query as Record<string, string>;
      const filter: Record<string, unknown> = {};

      if (req.sucursalId) {
        filter.$or = [{ sucursalOrigen: req.sucursalId }, { sucursalDestino: req.sucursalId }];
      } else if (req.user!.role !== 'admin') {
        const ids = req.user!.sucursales || [];
        filter.$or = [{ sucursalOrigen: { $in: ids } }, { sucursalDestino: { $in: ids } }];
      }
      if (estado) filter.estado = estado;

      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

      const [data, total] = await Promise.all([
        Transferencia.find(filter)
          .populate(POPULATE)
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        Transferencia.countDocuments(filter),
      ]);

      res.json({ data, pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) } });
    } catch (error) {
      console.error('Get transferencias error:', error);
      res.status(500).json({ message: 'Error al obtener transferencias.' });
    }
  }
);

// GET /api/transferencias/:id
router.get(
  '/:id',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const t = await cargar(req, res);
      if (!t) return;
      await t.populate(POPULATE);
      res.json(t);
    } catch (error) {
      console.error('Get transferencia error:', error);
      res.status(500).json({ message: 'Error al obtener transferencia.' });
    }
  }
);

// POST /api/transferencias — enviar stock desde la sucursal seleccionada
router.post(
  '/',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  resolveSucursal(),
  auditLog('enviar', 'transferencia'),
  [
    body('items').isArray({ min: 1 }).withMessage('Incluye al menos un ítem'),
    body('items.*.stock').isMongoId().withMessage('Stock inválido'),
    body('items.*.cantidad').isFloat({ gt: 0 }).withMessage('Cantidad debe ser mayor a 0'),
    body('sucursalDestino').optional({ values: 'falsy' }).isMongoId(),
    body('ubicacionDestino').optional({ values: 'falsy' }).isMongoId(),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    const hechos: { stock: Types.ObjectId; cantidad: number }[] = [];
    const transferId = new Types.ObjectId();
    try {
      if (!req.sucursalId) {
        res.status(400).json({ message: 'Selecciona la sucursal de origen.' });
        return;
      }
      const sucursalOrigen = req.sucursalId;
      const sucursalDestino = req.body.sucursalDestino
        ? new Types.ObjectId(String(req.body.sucursalDestino))
        : sucursalOrigen;

      if (!(await Sucursal.exists({ _id: sucursalDestino, activo: true }))) {
        res.status(400).json({ message: 'Sucursal de destino no encontrada o inactiva.' });
        return;
      }

      let ubicacionDestino: Types.ObjectId | undefined;
      if (req.body.ubicacionDestino) {
        const u = await Ubicacion.findOne({ _id: req.body.ubicacionDestino, sucursal: sucursalDestino, activo: true });
        if (!u) {
          res.status(400).json({ message: 'La ubicación de destino no pertenece a la sucursal de destino.' });
          return;
        }
        ubicacionDestino = u._id as Types.ObjectId;
      }

      // Validar filas de origen: misma sucursal y misma ubicación
      const filas = await SucursalStock.find({
        _id: { $in: req.body.items.map((i: { stock: string }) => i.stock) },
      });
      const porId = new Map(filas.map((f) => [String(f._id), f]));
      let ubicacionOrigen: Types.ObjectId | undefined;
      let primera = true;

      for (const it of req.body.items as { stock: string }[]) {
        const fila = porId.get(String(it.stock));
        if (!fila || String(fila.sucursal) !== String(sucursalOrigen)) {
          res.status(400).json({ message: 'Todo el stock debe ser de la sucursal de origen.' });
          return;
        }
        if (primera) {
          ubicacionOrigen = fila.ubicacion;
          primera = false;
        } else if (String(fila.ubicacion || '') !== String(ubicacionOrigen || '')) {
          res.status(400).json({ message: 'Todo el stock de una transferencia debe salir de la misma ubicación.' });
          return;
        }
      }

      if (
        String(sucursalOrigen) === String(sucursalDestino) &&
        String(ubicacionOrigen || '') === String(ubicacionDestino || '')
      ) {
        res.status(400).json({ message: 'El origen y el destino son el mismo lugar.' });
        return;
      }

      const codigo = generateCode('TR');
      const items: ITransferenciaItem[] = [];

      for (const it of req.body.items as { stock: string; cantidad: number }[]) {
        const fila = porId.get(String(it.stock))!;
        const cantidad = Number(it.cantidad);
        const { fila: actualizada, anterior } = await egresarStock(fila._id as Types.ObjectId, cantidad);
        hechos.push({ stock: fila._id as Types.ObjectId, cantidad });

        const product = await Product.findById(fila.producto).select('nombre');
        items.push({
          producto: fila.producto,
          nombre: product?.nombre || 'Producto',
          lote: fila.lote,
          cantidad,
          stockOrigen: fila._id as Types.ObjectId,
          cosecha: fila.cosecha,
          fechaVencimiento: fila.fechaVencimiento,
        });

        await registrarMovimiento({
          sucursal: sucursalOrigen,
          producto: fila.producto,
          tipo: 'transferencia_salida',
          cantidad: -cantidad,
          cantidadAnterior: anterior,
          cantidadNueva: actualizada.cantidadDisponible,
          lote: fila.lote,
          ubicacion: fila.ubicacion,
          stock: fila._id as Types.ObjectId,
          motivo: `Transferencia ${codigo} enviada`,
          referencia: { tipo: 'transferencia', id: transferId },
          usuario: req.user!._id as Types.ObjectId,
        });
      }

      const transferencia = await Transferencia.create({
        _id: transferId,
        codigo,
        sucursalOrigen,
        ubicacionOrigen,
        sucursalDestino,
        ubicacionDestino,
        items,
        estado: 'en_transito',
        enviadoPor: req.user!._id,
        fechaEnvio: new Date(),
        observaciones: req.body.observaciones,
      });

      await transferencia.populate(POPULATE);
      res.status(201).json(transferencia);
    } catch (error) {
      // Devolver lo que alcanzó a salir y borrar sus movimientos
      for (const h of hechos) {
        await SucursalStock.updateOne(
          { _id: h.stock },
          { $inc: { cantidadDisponible: h.cantidad }, $set: { estado: 'disponible' } }
        );
      }
      await InventoryMovement.deleteMany({ 'referencia.tipo': 'transferencia', 'referencia.id': transferId });
      if (error instanceof StockError) {
        res.status(error.status).json({ message: error.message });
        return;
      }
      console.error('Create transferencia error:', error);
      res.status(500).json({ message: 'Error al enviar la transferencia.' });
    }
  }
);

// PATCH /api/transferencias/:id/recibir — el destino confirma la llegada
router.patch(
  '/:id/recibir',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  auditLog('recibir', 'transferencia'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const t = await cargar(req, res);
      if (!t) return;
      if (!canAccessSucursal(req.user, t.sucursalDestino)) {
        res.status(403).json({ message: 'Solo la sucursal de destino puede recibir la transferencia.' });
        return;
      }
      // Se marca como recibida antes de mover stock, así dos recepciones simultáneas no duplican el ingreso.
      const reclamada = await Transferencia.findOneAndUpdate(
        { _id: t._id, estado: 'en_transito' },
        { estado: 'recibida', recibidoPor: req.user!._id, fechaRecepcion: new Date() },
        { new: true }
      );
      if (!reclamada) {
        res.status(400).json({ message: `La transferencia ya está ${t.estado === 'en_transito' ? 'procesada' : t.estado}.` });
        return;
      }
      t.estado = 'recibida';
      t.recibidoPor = req.user!._id as Types.ObjectId;
      t.fechaRecepcion = reclamada.fechaRecepcion;

      for (const item of t.items) {
        const { fila, anterior } = await ingresarStock({
          sucursal: t.sucursalDestino,
          producto: item.producto,
          lote: item.lote,
          ubicacion: t.ubicacionDestino || null,
          cosecha: item.cosecha || null,
          cantidad: item.cantidad,
          fechaVencimiento: item.fechaVencimiento,
        });
        item.stockDestino = fila._id as Types.ObjectId;

        await registrarMovimiento({
          sucursal: t.sucursalDestino,
          producto: item.producto,
          tipo: 'transferencia_entrada',
          cantidad: item.cantidad,
          cantidadAnterior: anterior,
          cantidadNueva: fila.cantidadDisponible,
          lote: item.lote,
          ubicacion: t.ubicacionDestino,
          stock: fila._id as Types.ObjectId,
          motivo: `Transferencia ${t.codigo} recibida`,
          referencia: { tipo: 'transferencia', id: t._id as Types.ObjectId },
          usuario: req.user!._id as Types.ObjectId,
        });
      }

      if (req.body.observaciones) {
        t.observaciones = [t.observaciones, `Recepción: ${req.body.observaciones}`].filter(Boolean).join('\n');
      }
      await t.save();
      await t.populate(POPULATE);
      res.json(t);
    } catch (error) {
      console.error('Receive transferencia error:', error);
      res.status(500).json({ message: 'Error al recibir la transferencia.' });
    }
  }
);

// PATCH /api/transferencias/:id/anular — devuelve el stock al origen (solo si sigue en tránsito)
router.patch(
  '/:id/anular',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('anular', 'transferencia'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const t = await cargar(req, res);
      if (!t) return;
      if (!canAccessSucursal(req.user, t.sucursalOrigen)) {
        res.status(403).json({ message: 'Solo la sucursal de origen puede anular la transferencia.' });
        return;
      }
      const reclamada = await Transferencia.findOneAndUpdate(
        { _id: t._id, estado: 'en_transito' },
        { estado: 'anulada', anuladoPor: req.user!._id, fechaAnulacion: new Date() },
        { new: true }
      );
      if (!reclamada) {
        res.status(400).json({ message: `No se puede anular: la transferencia ya está ${t.estado === 'en_transito' ? 'procesada' : t.estado}.` });
        return;
      }
      t.estado = 'anulada';
      t.anuladoPor = req.user!._id as Types.ObjectId;
      t.fechaAnulacion = reclamada.fechaAnulacion;

      for (const item of t.items) {
        const fila = await SucursalStock.findByIdAndUpdate(
          item.stockOrigen,
          { $inc: { cantidadDisponible: item.cantidad }, $set: { estado: 'disponible', activo: true } },
          { new: true }
        );
        await registrarMovimiento({
          sucursal: t.sucursalOrigen,
          producto: item.producto,
          tipo: 'transferencia_anulada',
          cantidad: item.cantidad,
          cantidadAnterior: fila ? fila.cantidadDisponible - item.cantidad : 0,
          cantidadNueva: fila ? fila.cantidadDisponible : item.cantidad,
          lote: item.lote,
          ubicacion: t.ubicacionOrigen,
          stock: item.stockOrigen,
          motivo: `Transferencia ${t.codigo} anulada${req.body.motivo ? `: ${req.body.motivo}` : ''}`,
          referencia: { tipo: 'transferencia', id: t._id as Types.ObjectId },
          usuario: req.user!._id as Types.ObjectId,
        });
      }

      if (req.body.motivo) {
        t.observaciones = [t.observaciones, `Anulación: ${req.body.motivo}`].filter(Boolean).join('\n');
      }
      await t.save();
      await t.populate(POPULATE);
      res.json(t);
    } catch (error) {
      console.error('Cancel transferencia error:', error);
      res.status(500).json({ message: 'Error al anular la transferencia.' });
    }
  }
);

export default router;
