import { Router, Response } from 'express';
import { Order } from '../models/Order';
import { Patient } from '../models/Patient';
import { Product } from '../models/Product';
import { SucursalStock } from '../models/SucursalStock';
import { Production } from '../models/Production';
import { FinanceTransaction } from '../models/Finance';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, getSucursalFilter } from '../middleware/sucursal';
import { auditLog } from '../middleware/audit';
import { EspacioCultivo } from '../models/Cultivo';
import { Transferencia } from '../models/Transferencia';
import { env } from '../config/env';
import { alertasVigencia } from '../services/vigencia';
import { registrarAuditoria } from '../services/audit';

const router = Router();

// GET /api/reports/dashboard
router.get(
  '/dashboard',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal({ required: false }),
  auditLog('consultar_reporte', 'dashboard'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const today = new Date();
      const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const sucFilter = getSucursalFilter(req);

      const [
        totalPacientes,
        pacientesAprobados,
        totalProductos,
        productosAgotados,
        pedidosMes,
        pedidosPendientes,
        ingresosMes,
        egresosMes,
        espaciosActivos,
        transferenciasEnTransito,
        vigencia,
      ] = await Promise.all([
        Patient.countDocuments(sucFilter),
        Patient.countDocuments({ estado: 'aprobado', ...sucFilter }),
        SucursalStock.countDocuments({ activo: true, ...sucFilter }),
        SucursalStock.countDocuments({ activo: true, estado: 'agotado', ...sucFilter }),
        Order.countDocuments({ createdAt: { $gte: startOfMonth }, ...sucFilter }),
        Order.countDocuments({ estado: { $in: ['pendiente_revision', 'aprobado', 'en_preparacion'] }, ...sucFilter }),
        FinanceTransaction.aggregate([
          { $match: { tipo: 'ingreso', fecha: { $gte: startOfMonth }, ...sucFilter } },
          { $group: { _id: null, total: { $sum: '$monto' } } },
        ]),
        FinanceTransaction.aggregate([
          { $match: { tipo: 'egreso', fecha: { $gte: startOfMonth }, ...sucFilter } },
          { $group: { _id: null, total: { $sum: '$monto' } } },
        ]),
        EspacioCultivo.countDocuments({ estado: 'activo', ...sucFilter }),
        Transferencia.countDocuments({
          estado: 'en_transito',
          ...(sucFilter.sucursal ? { sucursalDestino: sucFilter.sucursal } : {}),
        }),
        alertasVigencia(sucFilter),
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
        cultivo: {
          espaciosActivos,
          transferenciasEnTransito,
        },
        vigencia: {
          diasAviso: vigencia.diasAviso,
          porVencer: vigencia.porVencer.length,
          sinRecetaVigente: vigencia.sinRecetaVigente.length,
          suspendidosPorVencimiento: vigencia.suspendidosPorVencimiento.length,
        },
        pagosHabilitados: env.PAGOS_HABILITADOS,
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
  resolveSucursal({ required: false }),
  auditLog('consultar_reporte', 'dispensaciones_resumen'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { desde, hasta } = req.query as Record<string, string>;

      const dateFilter: Record<string, unknown> = {};
      if (desde) dateFilter.$gte = new Date(desde);
      if (hasta) dateFilter.$lte = new Date(hasta);

      const matchStage: Record<string, unknown> = { estado: 'entregado', ...getSucursalFilter(req) };
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
  resolveSucursal({ required: false }),
  auditLog('consultar_reporte', 'produccion'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const sucFilter = getSucursalFilter(req);
      const [productionByMonth, wasteByType] = await Promise.all([
        Production.aggregate([
          { $match: { estado: 'completado', ...sucFilter } },
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
          { $match: { ...sucFilter } },
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

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  // Evita fórmulas al abrir en Excel y escapa comillas
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * GET /api/reports/dispensaciones — detalle de dispensaciones entregadas, una fila por lote.
 * Pensado para responder una fiscalización. ?formato=csv descarga el archivo.
 */
router.get(
  '/dispensaciones',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal({ required: false }),
  auditLog('exportar_reporte', 'dispensaciones'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { desde, hasta, formato } = req.query as Record<string, string>;
      const match: Record<string, unknown> = { estado: 'entregado', ...getSucursalFilter(req) };
      if (desde || hasta) {
        const f: Record<string, Date> = {};
        if (desde) f.$gte = new Date(desde);
        if (hasta) {
          const h = new Date(hasta);
          h.setUTCHours(23, 59, 59, 999);
          f.$lte = h;
        }
        match.fechaEntrega = f;
      }

      const notas = await Order.find(match)
        .populate('paciente', 'nombre apellido rut')
        .populate('sucursal', 'nombre codigo')
        .populate('aprobadoPor', 'nombre apellido')
        .populate('historialEstados.usuario', 'nombre apellido')
        .populate('items.lotes.ubicacion', 'nombre codigo')
        .sort({ fechaEntrega: 1 })
        .limit(20000);

      type Persona = { nombre?: string; apellido?: string; rut?: string } | null;
      const nombre = (p: Persona) => (p ? `${p.nombre || ''} ${p.apellido || ''}`.trim() : '');

      const filas = notas.flatMap((n) => {
        const paciente = n.paciente as unknown as Persona;
        const sucursal = n.sucursal as unknown as { nombre?: string; codigo?: string } | null;
        const entrega = [...n.historialEstados].reverse().find((h) => h.estado === 'entregado');
        const base = {
          fechaEntrega: n.fechaEntrega ? new Date(n.fechaEntrega).toISOString() : '',
          nota: n.numeroPedido,
          sucursal: sucursal?.codigo || '',
          pacienteRut: paciente?.rut || '',
          paciente: nombre(paciente),
          receta: n.recetaMedica,
          aprobadoPor: nombre(n.aprobadoPor as unknown as Persona),
          entregadoPor: nombre(entrega?.usuario as unknown as Persona),
        };
        return n.items.flatMap((it) =>
          it.lotes && it.lotes.length > 0
            ? it.lotes.map((l) => ({
                ...base,
                producto: it.nombre,
                lote: l.lote,
                ubicacion: (l.ubicacion as unknown as { codigo?: string } | null)?.codigo || '',
                cantidad: l.cantidad,
              }))
            : [{ ...base, producto: it.nombre, lote: '(sin lote registrado)', ubicacion: '', cantidad: it.cantidad }]
        );
      });

      if (formato === 'csv') {
        const columnas = [
          'fechaEntrega',
          'nota',
          'sucursal',
          'pacienteRut',
          'paciente',
          'producto',
          'lote',
          'ubicacion',
          'cantidad',
          'receta',
          'aprobadoPor',
          'entregadoPor',
        ] as const;
        const csv = [
          columnas.join(','),
          ...filas.map((f) => columnas.map((c) => csvCell((f as Record<string, unknown>)[c])).join(',')),
        ].join('\n');
        // auditLog solo registra respuestas JSON; la descarga CSV se registra aquí
        void registrarAuditoria({
          req,
          usuario: String(req.user!._id),
          sucursal: req.sucursalId,
          accion: 'exportar_reporte',
          entidad: 'dispensaciones',
          detalles: { formato: 'csv', desde, hasta, filas: filas.length },
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="dispensaciones-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send('\uFEFF' + csv);
        return;
      }

      res.json({ total: filas.length, data: filas });
    } catch (error) {
      console.error('Get dispensaciones report error:', error);
      res.status(500).json({ message: 'Error al obtener reporte de dispensaciones.' });
    }
  }
);

export default router;
