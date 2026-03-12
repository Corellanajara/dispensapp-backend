import { Router, Response } from 'express';
import { Order } from '../models/Order';
import { Patient } from '../models/Patient';
import { Product } from '../models/Product';
import { Production } from '../models/Production';
import { FinanceTransaction } from '../models/Finance';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';

const router = Router();

// GET /api/reports/dashboard
router.get(
  '/dashboard',
  authenticate,
  authorize('admin', 'operador'),
  async (_req: AuthRequest, res: Response): Promise<void> => {
    try {
      const today = new Date();
      const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

      const [
        totalPacientes,
        pacientesAprobados,
        totalProductos,
        productosAgotados,
        pedidosMes,
        pedidosPendientes,
        ingresosMes,
        egresosMes,
      ] = await Promise.all([
        Patient.countDocuments(),
        Patient.countDocuments({ estado: 'aprobado' }),
        Product.countDocuments({ activo: true }),
        Product.countDocuments({ activo: true, estado: 'agotado' }),
        Order.countDocuments({ createdAt: { $gte: startOfMonth } }),
        Order.countDocuments({ estado: { $in: ['pendiente_revision', 'aprobado', 'en_preparacion'] } }),
        FinanceTransaction.aggregate([
          { $match: { tipo: 'ingreso', fecha: { $gte: startOfMonth } } },
          { $group: { _id: null, total: { $sum: '$monto' } } },
        ]),
        FinanceTransaction.aggregate([
          { $match: { tipo: 'egreso', fecha: { $gte: startOfMonth } } },
          { $group: { _id: null, total: { $sum: '$monto' } } },
        ]),
      ]);

      res.json({
        pacientes: {
          total: totalPacientes,
          aprobados: pacientesAprobados,
        },
        productos: {
          total: totalProductos,
          agotados: productosAgotados,
        },
        pedidos: {
          mes: pedidosMes,
          pendientes: pedidosPendientes,
        },
        finanzas: {
          ingresosMes: ingresosMes[0]?.total || 0,
          egresosMes: egresosMes[0]?.total || 0,
          balance: (ingresosMes[0]?.total || 0) - (egresosMes[0]?.total || 0),
        },
      });
    } catch (error) {
      console.error('Get dashboard error:', error);
      res.status(500).json({ message: 'Error al obtener dashboard.' });
    }
  }
);

// GET /api/reports/sales
router.get(
  '/sales',
  authenticate,
  authorize('admin', 'operador', 'finanzas'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { desde, hasta } = req.query as Record<string, string>;

      const dateFilter: Record<string, unknown> = {};
      if (desde) dateFilter.$gte = new Date(desde);
      if (hasta) dateFilter.$lte = new Date(hasta);

      const matchStage: Record<string, unknown> = { estado: 'entregado' };
      if (Object.keys(dateFilter).length > 0) {
        matchStage.fechaEntrega = dateFilter;
      }

      const [salesByMonth, topProducts] = await Promise.all([
        Order.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: {
                year: { $year: '$createdAt' },
                month: { $month: '$createdAt' },
              },
              totalVentas: { $sum: '$total' },
              cantidadPedidos: { $sum: 1 },
            },
          },
          { $sort: { '_id.year': -1, '_id.month': -1 } },
          { $limit: 12 },
        ]),
        Order.aggregate([
          { $match: matchStage },
          { $unwind: '$items' },
          {
            $group: {
              _id: '$items.nombre',
              totalVendido: { $sum: '$items.cantidad' },
              totalIngresos: { $sum: '$items.subtotal' },
            },
          },
          { $sort: { totalVendido: -1 } },
          { $limit: 10 },
        ]),
      ]);

      res.json({
        ventasPorMes: salesByMonth,
        productosTop: topProducts,
      });
    } catch (error) {
      console.error('Get sales report error:', error);
      res.status(500).json({ message: 'Error al obtener reporte de ventas.' });
    }
  }
);

// GET /api/reports/production
router.get(
  '/production',
  authenticate,
  authorize('admin', 'produccion'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const [productionByMonth, wasteByType] = await Promise.all([
        Production.aggregate([
          { $match: { estado: 'completado' } },
          {
            $group: {
              _id: {
                year: { $year: '$fechaInicio' },
                month: { $month: '$fechaInicio' },
              },
              totalProducido: { $sum: '$cantidadProducida' },
              totalMermas: { $sum: '$totalMermas' },
              cantidadProcesos: { $sum: 1 },
            },
          },
          { $sort: { '_id.year': -1, '_id.month': -1 } },
          { $limit: 12 },
        ]),
        Production.aggregate([
          { $unwind: '$mermas' },
          {
            $group: {
              _id: '$mermas.tipo',
              totalCantidad: { $sum: '$mermas.cantidad' },
              count: { $sum: 1 },
            },
          },
          { $sort: { totalCantidad: -1 } },
        ]),
      ]);

      res.json({
        produccionPorMes: productionByMonth,
        mermasPorTipo: wasteByType,
      });
    } catch (error) {
      console.error('Get production report error:', error);
      res.status(500).json({ message: 'Error al obtener reporte de producción.' });
    }
  }
);

export default router;
