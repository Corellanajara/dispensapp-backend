import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { FinanceTransaction } from '../models/Finance';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';

const router = Router();

// GET /api/finance/transactions
router.get(
  '/transactions',
  authenticate,
  authorize('admin', 'finanzas'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '20',
        tipo,
        categoria,
        desde,
        hasta,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = {};
      if (tipo) filter.tipo = tipo;
      if (categoria) filter.categoria = categoria;
      if (desde || hasta) {
        filter.fecha = {};
        if (desde) (filter.fecha as Record<string, unknown>).$gte = new Date(desde);
        if (hasta) (filter.fecha as Record<string, unknown>).$lte = new Date(hasta);
      }

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [transactions, total] = await Promise.all([
        FinanceTransaction.find(filter)
          .populate('usuario', 'nombre apellido')
          .sort({ fecha: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        FinanceTransaction.countDocuments(filter),
      ]);

      res.json({
        data: transactions,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get transactions error:', error);
      res.status(500).json({ message: 'Error al obtener transacciones.' });
    }
  }
);

// POST /api/finance/transactions
router.post(
  '/transactions',
  authenticate,
  authorize('admin', 'finanzas'),
  auditLog('crear', 'transaccion'),
  [
    body('tipo').isIn(['ingreso', 'egreso']).withMessage('Tipo inválido'),
    body('monto').isNumeric().withMessage('Monto debe ser numérico'),
    body('descripcion').notEmpty().withMessage('Descripción es requerida'),
    body('categoria').notEmpty().withMessage('Categoría es requerida'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const transaction = await FinanceTransaction.create({
        ...req.body,
        usuario: req.user!._id,
      });
      res.status(201).json(transaction);
    } catch (error) {
      console.error('Create transaction error:', error);
      res.status(500).json({ message: 'Error al crear transacción.' });
    }
  }
);

// GET /api/finance/summary
router.get(
  '/summary',
  authenticate,
  authorize('admin', 'finanzas'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { desde, hasta } = req.query as Record<string, string>;

      const dateFilter: Record<string, unknown> = {};
      if (desde) dateFilter.$gte = new Date(desde);
      if (hasta) dateFilter.$lte = new Date(hasta);

      const matchStage: Record<string, unknown> = {};
      if (Object.keys(dateFilter).length > 0) {
        matchStage.fecha = dateFilter;
      }

      const [ingresos, egresos, byCategory] = await Promise.all([
        FinanceTransaction.aggregate([
          { $match: { ...matchStage, tipo: 'ingreso' } },
          { $group: { _id: null, total: { $sum: '$monto' }, count: { $sum: 1 } } },
        ]),
        FinanceTransaction.aggregate([
          { $match: { ...matchStage, tipo: 'egreso' } },
          { $group: { _id: null, total: { $sum: '$monto' }, count: { $sum: 1 } } },
        ]),
        FinanceTransaction.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: { tipo: '$tipo', categoria: '$categoria' },
              total: { $sum: '$monto' },
              count: { $sum: 1 },
            },
          },
          { $sort: { total: -1 } },
        ]),
      ]);

      const totalIngresos = ingresos[0]?.total || 0;
      const totalEgresos = egresos[0]?.total || 0;

      res.json({
        ingresos: {
          total: totalIngresos,
          cantidad: ingresos[0]?.count || 0,
        },
        egresos: {
          total: totalEgresos,
          cantidad: egresos[0]?.count || 0,
        },
        balance: totalIngresos - totalEgresos,
        porCategoria: byCategory,
      });
    } catch (error) {
      console.error('Get finance summary error:', error);
      res.status(500).json({ message: 'Error al obtener resumen financiero.' });
    }
  }
);

// GET /api/finance/cashflow
router.get(
  '/cashflow',
  authenticate,
  authorize('admin', 'finanzas'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { meses = '6' } = req.query as Record<string, string>;
      const numMeses = parseInt(meses, 10);

      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - numMeses);

      const cashflow = await FinanceTransaction.aggregate([
        { $match: { fecha: { $gte: startDate } } },
        {
          $group: {
            _id: {
              year: { $year: '$fecha' },
              month: { $month: '$fecha' },
              tipo: '$tipo',
            },
            total: { $sum: '$monto' },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]);

      res.json(cashflow);
    } catch (error) {
      console.error('Get cashflow error:', error);
      res.status(500).json({ message: 'Error al obtener flujo de caja.' });
    }
  }
);

export default router;
