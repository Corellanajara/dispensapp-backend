import mongoose, { Types } from 'mongoose';
import { IPatient, IPrescripcion, IItemPrescripcion } from '../models/Patient';
import { Product, ProductType } from '../models/Product';
import { Order } from '../models/Order';
import { recetaVigente } from './vigencia';

/**
 * Lo que autoriza la receta médica. Lo registra el administrador al aprobar la receta y queda en ella:
 * cada ítem es un tipo de producto (o un producto puntual) con un tope opcional de unidades cada 30 días.
 * Las dispensaciones solo pueden incluir lo autorizado por la receta vigente.
 * Las recetas aprobadas antes de existir esto no tienen prescripción: para ellas no se restringe nada.
 */

export const TIPOS_PRODUCTO: ProductType[] = ['flor', 'aceite', 'crema', 'capsula', 'tintura', 'comestible', 'otro'];

export class PrescripcionError extends Error {
  status = 400;
}

/** Valida y normaliza la prescripción que envía el administrador. */
export async function leerPrescripcion(raw: unknown, usuario: Types.ObjectId): Promise<IPrescripcion> {
  const p = (raw ?? {}) as { items?: unknown; indicaciones?: unknown };
  if (!Array.isArray(p.items) || p.items.length === 0) {
    throw new PrescripcionError('Indica lo que autoriza la receta: al menos un producto o tipo de producto.');
  }
  if (p.items.length > 20) throw new PrescripcionError('La receta admite como máximo 20 ítems.');

  const items: IItemPrescripcion[] = [];
  for (const [i, it] of (p.items as Record<string, unknown>[]).entries()) {
    const n = i + 1;
    let tipo = String(it?.tipoProducto ?? '') as ProductType;
    let producto: Types.ObjectId | undefined;
    let nombreProducto: string | undefined;
    if (it?.producto) {
      if (!mongoose.Types.ObjectId.isValid(String(it.producto))) throw new PrescripcionError(`Ítem ${n}: producto inválido.`);
      const prod = await Product.findById(it.producto).select('tipo nombre');
      if (!prod) throw new PrescripcionError(`Ítem ${n}: el producto no existe.`);
      producto = prod._id as Types.ObjectId;
      nombreProducto = prod.nombre;
      tipo = prod.tipo;
    }
    if (!TIPOS_PRODUCTO.includes(tipo)) throw new PrescripcionError(`Ítem ${n}: elige el tipo de producto.`);

    const descripcion = it?.descripcion ? String(it.descripcion).trim().slice(0, 300) : undefined;
    let cantidadMensual: number | undefined;
    if (it?.cantidadMensual !== undefined && it.cantidadMensual !== null && it.cantidadMensual !== '') {
      cantidadMensual = Number(it.cantidadMensual);
      if (!Number.isInteger(cantidadMensual) || cantidadMensual < 0 || cantidadMensual > 10000) {
        throw new PrescripcionError(`Ítem ${n}: la cantidad cada 30 días debe ser un número entero.`);
      }
      if (cantidadMensual === 0) cantidadMensual = undefined;
    }
    items.push({ tipoProducto: tipo, producto, nombreProducto, descripcion, cantidadMensual });
  }

  const indicaciones = p.indicaciones ? String(p.indicaciones).trim().slice(0, 1000) : undefined;
  return { items, indicaciones, registradoPor: usuario, fecha: new Date() };
}

/** Prescripción de la receta vigente del paciente, o null (sin receta vigente o receta antigua sin prescripción). */
export function prescripcionVigente(patient: Pick<IPatient, 'documentos'>): IPrescripcion | null {
  const p = recetaVigente(patient)?.prescripcion;
  return p && p.items?.length ? p : null;
}

interface ProductoNota {
  _id: Types.ObjectId | string;
  tipo: ProductType;
  nombre: string;
}

/** Ítem de la receta que autoriza este producto: primero el producto puntual, luego el tipo. */
function itemQueAutoriza(p: IPrescripcion, prod: ProductoNota): IItemPrescripcion | undefined {
  return (
    p.items.find((i) => i.producto && String(i.producto) === String(prod._id)) ??
    p.items.find((i) => !i.producto && i.tipoProducto === prod.tipo)
  );
}

/**
 * Revisa que lo pedido esté autorizado por la receta vigente y no supere los topes de cada ítem
 * en los últimos 30 días (sin contar notas anuladas ni la nota que se está revisando).
 */
export async function validarContraPrescripcion(
  patient: IPatient,
  pedido: { producto: Types.ObjectId; cantidad: number }[],
  excluirNota?: Types.ObjectId
): Promise<void> {
  const p = prescripcionVigente(patient);
  if (!p) return;

  const productos = await Product.find({ _id: { $in: pedido.map((i) => i.producto) } }).select('nombre tipo');
  const porId = new Map(productos.map((x) => [String(x._id), x as unknown as ProductoNota]));

  const usoPedido = new Map<IItemPrescripcion, number>();
  for (const it of pedido) {
    const prod = porId.get(String(it.producto));
    if (!prod) continue;
    const item = itemQueAutoriza(p, prod);
    if (!item) {
      throw new PrescripcionError(`La receta del paciente no autoriza ${prod.nombre} (${prod.tipo}).`);
    }
    usoPedido.set(item, (usoPedido.get(item) ?? 0) + it.cantidad);
  }

  const conTope = [...usoPedido.keys()].filter((i) => i.cantidadMensual && i.cantidadMensual > 0);
  if (conTope.length === 0) return;

  const desde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const filtro: Record<string, unknown> = { paciente: patient._id, estado: { $ne: 'cancelado' }, createdAt: { $gte: desde } };
  if (excluirNota) filtro._id = { $ne: excluirNota };
  const notas = await Order.find(filtro).select('items.producto items.cantidad').populate('items.producto', 'nombre tipo');

  for (const item of conTope) {
    let usadas = 0;
    for (const nota of notas) {
      for (const it of nota.items) {
        const prod = it.producto as unknown as ProductoNota | null;
        if (prod && typeof prod === 'object' && 'tipo' in prod && itemQueAutoriza(p, prod) === item) usadas += it.cantidad;
      }
    }
    const nuevas = usoPedido.get(item) ?? 0;
    if (usadas + nuevas > item.cantidadMensual!) {
      const nombre = item.nombreProducto || item.descripcion || `productos de tipo ${item.tipoProducto}`;
      const tope = item.cantidadMensual!;
      throw new PrescripcionError(
        `Supera lo que autoriza la receta para ${nombre}: ${tope} unidad${tope === 1 ? '' : 'es'} cada 30 días ` +
          `(ya tiene ${usadas}, se piden ${nuevas}).`
      );
    }
  }
}
