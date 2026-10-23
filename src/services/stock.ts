import { Types } from 'mongoose';
import { SucursalStock, ISucursalStock } from '../models/SucursalStock';
import { Ubicacion } from '../models/Ubicacion';
import { InventoryMovement, MovementType, MovementReference } from '../models/Inventory';
import { IOrder, IOrderItemAllocation } from '../models/Order';

/**
 * Operaciones de stock por lote y ubicación.
 *
 * Una fila de SucursalStock = (sucursal, producto, lote, ubicación).
 * Solo se puede dispensar el stock sin ubicación o en una ubicación de tipo "dispensario".
 * Las reservas y descuentos usan actualizaciones atómicas para evitar stock negativo.
 */

export class StockError extends Error {
  status = 400;
}

type Id = Types.ObjectId | string;

function estadoPara(disponible: number): 'disponible' | 'agotado' {
  return disponible > 0 ? 'disponible' : 'agotado';
}

async function actualizarEstado(row: ISucursalStock | null): Promise<void> {
  if (!row) return;
  const estado = estadoPara(row.cantidadDisponible);
  if (row.estado !== estado) {
    await SucursalStock.updateOne({ _id: row._id }, { estado });
  }
}

/** Filtro de filas que se pueden dispensar en una sucursal. */
export async function filtroDispensable(sucursal: Id): Promise<Record<string, unknown>> {
  const ubicaciones = await Ubicacion.find({ sucursal, tipo: 'dispensario' }).distinct('_id');
  return {
    sucursal,
    activo: true,
    $or: [{ ubicacion: null }, { ubicacion: { $in: ubicaciones } }],
  };
}

/** Filas dispensables de un producto, primero las que vencen antes. */
export async function filasDispensables(sucursal: Id, producto: Id) {
  const filtro = await filtroDispensable(sucursal);
  return SucursalStock.find({ ...filtro, producto }).sort({ fechaVencimiento: 1, createdAt: 1 });
}

/** Cantidad dispensable de un producto en una sucursal. */
export async function disponibleParaDispensar(sucursal: Id, producto: Id): Promise<number> {
  const filas = await filasDispensables(sucursal, producto);
  return filas.reduce((sum, f) => sum + f.cantidadDisponible, 0);
}

interface MovimientoParams {
  sucursal: Id;
  producto: Id;
  tipo: MovementType;
  cantidad: number;
  cantidadAnterior: number;
  cantidadNueva: number;
  lote: string;
  ubicacion?: Id | null;
  stock?: Id;
  motivo: string;
  referencia?: { tipo: MovementReference; id: Id };
  usuario: Id;
}

export async function registrarMovimiento(p: MovimientoParams) {
  return InventoryMovement.create({ ...p, ubicacion: p.ubicacion || undefined });
}

/**
 * Suma stock a la fila (sucursal, producto, lote, ubicación), creándola si no existe.
 */
export async function ingresarStock(params: {
  sucursal: Id;
  producto: Id;
  lote: string;
  cantidad: number;
  ubicacion?: Id | null;
  cosecha?: Id | null;
  fechaProduccion?: Date;
  fechaVencimiento?: Date;
}): Promise<{ fila: ISucursalStock; anterior: number }> {
  const filtro = {
    sucursal: params.sucursal,
    producto: params.producto,
    lote: params.lote,
    ubicacion: params.ubicacion || null,
  };

  const antes = await SucursalStock.findOne(filtro);
  const anterior = antes ? antes.cantidadDisponible : 0;

  const fila = await SucursalStock.findOneAndUpdate(
    filtro,
    {
      $inc: { cantidadDisponible: params.cantidad },
      $set: { activo: true },
      $setOnInsert: {
        cantidadReservada: 0,
        cosecha: params.cosecha || undefined,
        fechaProduccion: params.fechaProduccion,
        fechaVencimiento: params.fechaVencimiento,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  await actualizarEstado(fila);
  return { fila: fila!, anterior };
}

/**
 * Resta stock disponible de una fila. Falla si no alcanza.
 */
export async function egresarStock(stockId: Id, cantidad: number): Promise<{ fila: ISucursalStock; anterior: number }> {
  const fila = await SucursalStock.findOneAndUpdate(
    { _id: stockId, cantidadDisponible: { $gte: cantidad } },
    { $inc: { cantidadDisponible: -cantidad } },
    { new: true }
  );
  if (!fila) {
    const actual = await SucursalStock.findById(stockId);
    throw new StockError(
      actual
        ? `Stock insuficiente en el lote ${actual.lote}. Disponible: ${actual.cantidadDisponible}`
        : 'Fila de stock no encontrada.'
    );
  }
  await actualizarEstado(fila);
  return { fila, anterior: fila.cantidadDisponible + cantidad };
}

/**
 * Reserva stock para una nota de dispensación aprobada.
 * Toma de los lotes dispensables que vencen antes y guarda en cada ítem de qué lote salió.
 * Si no alcanza, deshace lo reservado y lanza StockError.
 */
export async function reservarParaNota(order: IOrder): Promise<void> {
  const hechas: { stock: Id; cantidad: number }[] = [];

  try {
    for (const item of order.items) {
      let restante = item.cantidad;
      const asignaciones: IOrderItemAllocation[] = [];
      const filas = await filasDispensables(order.sucursal, item.producto);

      for (const fila of filas) {
        if (restante <= 0) break;
        const tomar = Math.min(fila.cantidadDisponible, restante);
        if (tomar <= 0) continue;

        const actualizada = await SucursalStock.findOneAndUpdate(
          { _id: fila._id, cantidadDisponible: { $gte: tomar } },
          { $inc: { cantidadDisponible: -tomar, cantidadReservada: tomar } },
          { new: true }
        );
        if (!actualizada) continue; // otra operación la tomó; sigue con la próxima fila

        await actualizarEstado(actualizada);
        hechas.push({ stock: fila._id as Types.ObjectId, cantidad: tomar });
        asignaciones.push({
          stock: fila._id as Types.ObjectId,
          lote: fila.lote,
          cantidad: tomar,
          ubicacion: fila.ubicacion,
          cosecha: fila.cosecha,
        });
        restante -= tomar;
      }

      if (restante > 0) {
        throw new StockError(`Stock insuficiente para ${item.nombre}. Faltan ${restante} unidad(es).`);
      }
      item.lotes = asignaciones;
    }
  } catch (err) {
    for (const h of hechas) {
      const fila = await SucursalStock.findByIdAndUpdate(
        h.stock,
        { $inc: { cantidadDisponible: h.cantidad, cantidadReservada: -h.cantidad } },
        { new: true }
      );
      await actualizarEstado(fila);
    }
    for (const item of order.items) item.lotes = [];
    throw err;
  }
}

/** Devuelve al disponible lo reservado por una nota (al anular). */
export async function liberarReservaDeNota(order: IOrder): Promise<void> {
  for (const item of order.items) {
    if (item.lotes && item.lotes.length > 0) {
      for (const a of item.lotes) {
        const fila = await SucursalStock.findByIdAndUpdate(
          a.stock,
          { $inc: { cantidadDisponible: a.cantidad, cantidadReservada: -a.cantidad } },
          { new: true }
        );
        await actualizarEstado(fila);
      }
      item.lotes = [];
    } else {
      // Notas antiguas, sin lotes asignados
      const fila = await SucursalStock.findOneAndUpdate(
        { producto: item.producto, sucursal: order.sucursal },
        { $inc: { cantidadDisponible: item.cantidad, cantidadReservada: -item.cantidad } },
        { new: true }
      );
      await actualizarEstado(fila);
    }
  }
}

/** Descuenta definitivamente lo reservado al entregar la nota y deja el movimiento en el historial. */
export async function consumirReservaDeNota(order: IOrder, usuario: Id): Promise<void> {
  const motivo = `Dispensación - Nota ${order.numeroPedido}`;
  const referencia = { tipo: 'orden' as const, id: order._id as Types.ObjectId };

  for (const item of order.items) {
    if (item.lotes && item.lotes.length > 0) {
      for (const a of item.lotes) {
        const fila = await SucursalStock.findByIdAndUpdate(
          a.stock,
          { $inc: { cantidadReservada: -a.cantidad } },
          { new: true }
        );
        const totalNuevo = fila ? fila.cantidadDisponible + fila.cantidadReservada : 0;
        await registrarMovimiento({
          sucursal: order.sucursal,
          producto: item.producto,
          tipo: 'dispensacion',
          cantidad: -a.cantidad,
          cantidadAnterior: totalNuevo + a.cantidad,
          cantidadNueva: totalNuevo,
          lote: a.lote,
          ubicacion: a.ubicacion,
          stock: a.stock,
          motivo,
          referencia,
          usuario,
        });
      }
    } else {
      // Notas antiguas, sin lotes asignados
      const fila = await SucursalStock.findOneAndUpdate(
        { producto: item.producto, sucursal: order.sucursal },
        { $inc: { cantidadReservada: -item.cantidad } },
        { new: true }
      );
      if (fila) {
        const totalNuevo = fila.cantidadDisponible + fila.cantidadReservada;
        await registrarMovimiento({
          sucursal: order.sucursal,
          producto: item.producto,
          tipo: 'dispensacion',
          cantidad: -item.cantidad,
          cantidadAnterior: totalNuevo + item.cantidad,
          cantidadNueva: totalNuevo,
          lote: fila.lote,
          ubicacion: fila.ubicacion,
          stock: fila._id as Types.ObjectId,
          motivo,
          referencia,
          usuario,
        });
      }
    }
  }
}
