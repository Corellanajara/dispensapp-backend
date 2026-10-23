/**
 * Diagnóstico de datos antiguos frente al nuevo modelo de trazabilidad.
 *
 * Uso (solo lectura, no cambia nada):
 *   npx tsx src/scripts/diagnostico-migracion.ts
 *
 * Para asignar a un dispensario todos los pacientes que no tienen uno:
 *   npx tsx src/scripts/diagnostico-migracion.ts --asignar-sucursal=CODIGO
 *   (ej. --asignar-sucursal=SCL). Esto sí modifica datos y queda en auditoría.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/database';
import { Patient } from '../models/Patient';
import { Sucursal } from '../models/Sucursal';
import { User } from '../models/User';
import { Order } from '../models/Order';
import { AuditLog } from '../models/AuditLog';
import { recetaVigente } from '../services/vigencia';

async function main() {
  const asignarArg = process.argv.find((a) => a.startsWith('--asignar-sucursal='));
  const codigoAsignar = asignarArg?.split('=')[1]?.toUpperCase();

  await connectDB();

  const sucursales = await Sucursal.find().select('nombre codigo activo');
  console.log('\n== Sucursales');
  for (const s of sucursales) console.log(`  ${s.codigo}  ${s.nombre}${s.activo ? '' : ' (inactiva)'}`);

  const pacientes = await Patient.find().select('nombre apellido rut estado sucursal documentos limiteCompra limiteMensualUnidades');

  const sinSucursal = pacientes.filter((p) => !p.sucursal);
  const activosSinReceta = pacientes.filter((p) => p.estado === 'aprobado' && !recetaVigente(p));
  const recetasSinFecha = pacientes.filter((p) =>
    p.documentos.some((d) => d.tipo === 'receta_medica' && !d.fechaVencimiento)
  );
  const conLimiteAntiguo = pacientes.filter((p) => (p.limiteCompra || 0) > 0 && !p.limiteMensualUnidades);
  const docsAntiguos = pacientes.filter((p) =>
    p.documentos.some((d) => !d.archivo.startsWith('local:') && !d.archivo.startsWith('s3:'))
  );

  const lista = (arr: typeof pacientes) =>
    arr.slice(0, 50).forEach((p) => console.log(`    - ${p.rut}  ${p.nombre} ${p.apellido}  (${p.estado})`));

  console.log(`\n== Pacientes: ${pacientes.length}`);

  console.log(`\n  Sin dispensario asignado: ${sinSucursal.length}`);
  console.log('  → No se pueden activar ni recibir espacios de cultivo hasta asignarles uno.');
  lista(sinSucursal);

  console.log(`\n  Activos sin receta aprobada y vigente: ${activosSinReceta.length}`);
  console.log('  → No podrán recibir dispensaciones hasta que se apruebe una receta con fecha de vencimiento.');
  lista(activosSinReceta);

  console.log(`\n  Con recetas sin fecha de vencimiento: ${recetasSinFecha.length}`);
  console.log('  → Al revisar la receta, el admin debe indicar la fecha de vencimiento.');
  lista(recetasSinFecha);

  console.log(`\n  Con límite antiguo en pesos y sin límite mensual en unidades: ${conLimiteAntiguo.length}`);
  console.log('  → El límite en pesos ya no se usa. Definir limiteMensualUnidades si corresponde.');
  lista(conLimiteAntiguo);

  console.log(`\n  Con documentos subidos antes del cambio (ruta antigua): ${docsAntiguos.length}`);
  console.log('  → Siguen funcionando con enlace temporal. Ya no son públicos por URL directa.');

  const notasSinLote = await Order.countDocuments({
    estado: { $in: ['aprobado', 'en_preparacion', 'listo_retiro', 'en_despacho'] },
    'items.lotes.0': { $exists: false },
  });
  console.log(`\n== Notas aprobadas sin lote asignado (antiguas, en curso): ${notasSinLote}`);
  console.log('  → Se entregan igual; el descuento usa la fila de stock antigua del producto.');

  const admins = await User.countDocuments({ role: 'admin', activo: true });
  console.log(`\n== Administradores activos: ${admins}`);
  console.log('  → Revisa que todos sean legítimos: antes cualquiera podía crearse una cuenta admin.');
  const adminsList = await User.find({ role: 'admin' }).select('email nombre apellido createdAt activo');
  adminsList.forEach((u) => console.log(`    - ${u.email}  ${u.nombre} ${u.apellido}  creado ${u.createdAt?.toISOString().slice(0, 10)}${u.activo ? '' : ' (inactivo)'}`));

  if (codigoAsignar) {
    const suc = sucursales.find((s) => s.codigo === codigoAsignar);
    if (!suc) {
      console.error(`\nNo existe la sucursal ${codigoAsignar}. No se cambió nada.`);
    } else {
      const res = await Patient.updateMany({ sucursal: null }, { $set: { sucursal: suc._id } });
      await AuditLog.create({
        accion: 'migracion_asignar_sucursal',
        entidad: 'paciente',
        sucursal: suc._id,
        detalles: { pacientes: res.modifiedCount, script: 'diagnostico-migracion' },
      });
      console.log(`\n== Asignados ${res.modifiedCount} paciente(s) a ${suc.codigo} (${suc.nombre}).`);
    }
  } else {
    console.log('\n(No se modificó nada. Usa --asignar-sucursal=CODIGO para asignar los pacientes sin dispensario.)');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
