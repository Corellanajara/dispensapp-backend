import { connectDB } from './config/database';
import { User } from './models/User';
import { Patient } from './models/Patient';
import { Product } from './models/Product';
import { Sucursal } from './models/Sucursal';
import { SucursalStock } from './models/SucursalStock';
import { Ubicacion } from './models/Ubicacion';
import { EspacioCultivo, Cosecha } from './models/Cultivo';
import { Transferencia } from './models/Transferencia';
import { Order } from './models/Order';
import { InventoryMovement } from './models/Inventory';
import { AuditLog } from './models/AuditLog';
import { env } from './config/env';
import { generateCode, generateQRToken } from './utils/helpers';

async function seed() {
  // El seed BORRA TODA la base de datos. Solo corre contra una base local,
  // salvo que se confirme explícitamente con SEED_CONFIRMAR=borrar-todo.
  const esLocal = /mongodb:\/\/(localhost|127\.0\.0\.1)/.test(env.MONGODB_URI);
  if (!esLocal && process.env.SEED_CONFIRMAR !== 'borrar-todo') {
    console.error(
      'Seed cancelado: MONGODB_URI no es local y el seed borra todos los datos.\n' +
        'Si de verdad quieres borrar esa base, ejecuta: SEED_CONFIRMAR=borrar-todo npm run seed'
    );
    process.exit(1);
  }

  await connectDB();

  console.log('Cleaning database...');
  await User.deleteMany({});
  await Patient.deleteMany({});
  await Product.deleteMany({});
  await Sucursal.deleteMany({});
  await SucursalStock.deleteMany({});
  await Ubicacion.deleteMany({});
  await EspacioCultivo.deleteMany({});
  await Cosecha.deleteMany({});
  await Transferencia.deleteMany({});
  await Order.deleteMany({});
  await InventoryMovement.deleteMany({});
  await AuditLog.deleteMany({});

  console.log('Creating sucursales...');
  const sucursalSantiago = await Sucursal.create({
    nombre: 'Dispensario Santiago Centro',
    codigo: 'SCL',
    direccion: {
      calle: 'Av. Libertador Bernardo O\'Higgins',
      numero: '1234',
      comuna: 'Santiago',
      ciudad: 'Santiago',
      region: 'Metropolitana',
    },
    telefono: '+56212345678',
    email: 'santiago@dispensario.cl',
    horarioAtencion: 'Lunes a Viernes 9:00 - 18:00',
  });

  const sucursalValpo = await Sucursal.create({
    nombre: 'Dispensario Valparaíso',
    codigo: 'VLP',
    direccion: {
      calle: 'Av. Brasil',
      numero: '567',
      comuna: 'Valparaíso',
      ciudad: 'Valparaíso',
      region: 'Valparaíso',
    },
    telefono: '+56322345678',
    email: 'valparaiso@dispensario.cl',
    horarioAtencion: 'Lunes a Viernes 9:00 - 17:00',
  });

  console.log('Creating admin user...');
  const admin = await User.create({
    email: 'admin@dispensario.cl',
    password: 'admin123',
    nombre: 'Administrador',
    apellido: 'Sistema',
    rut: '11111111-1',
    role: 'admin',
    telefono: '+56912345678',
    sucursales: [sucursalSantiago._id, sucursalValpo._id],
    sucursalActiva: sucursalSantiago._id,
  });

  console.log('Creating operator user...');
  await User.create({
    email: 'operador@dispensario.cl',
    password: 'operador123',
    nombre: 'Carlos',
    apellido: 'Operador',
    rut: '22222222-2',
    role: 'operador',
    telefono: '+56987654321',
    sucursales: [sucursalSantiago._id],
    sucursalActiva: sucursalSantiago._id,
  });

  console.log('Creating production user...');
  await User.create({
    email: 'produccion@dispensario.cl',
    password: 'produccion123',
    nombre: 'María',
    apellido: 'Producción',
    rut: '33333333-3',
    role: 'produccion',
    telefono: '+56911111111',
    sucursales: [sucursalSantiago._id, sucursalValpo._id],
    sucursalActiva: sucursalSantiago._id,
  });

  console.log('Creating finance user...');
  await User.create({
    email: 'finanzas@dispensario.cl',
    password: 'finanzas123',
    nombre: 'Pedro',
    apellido: 'Finanzas',
    rut: '44444444-4',
    role: 'finanzas',
    telefono: '+56922222222',
    sucursales: [sucursalSantiago._id, sucursalValpo._id],
    sucursalActiva: sucursalSantiago._id,
  });

  console.log('Creating cultivation user...');
  await User.create({
    email: 'cultivo@dispensario.cl',
    password: 'cultivo123',
    nombre: 'Laura',
    apellido: 'Cultivo',
    rut: '55555555-5',
    role: 'cultivo',
    telefono: '+56933334444',
    sucursales: [sucursalSantiago._id],
    sucursalActiva: sucursalSantiago._id,
  });

  console.log('Creating patient users...');
  const paciente1 = await User.create({
    email: 'paciente1@dispensario.cl',
    password: 'paciente123',
    nombre: 'Juan',
    apellido: 'Pérez',
    rut: '12345678-9',
    role: 'paciente',
    telefono: '+56977777777',
  });

  const paciente2 = await User.create({
    email: 'paciente2@dispensario.cl',
    password: 'paciente123',
    nombre: 'María',
    apellido: 'González',
    rut: '98765432-1',
    role: 'paciente',
    telefono: '+56988888888',
  });

  const enUnAnio = new Date();
  enUnAnio.setFullYear(enUnAnio.getFullYear() + 1);

  console.log('Creating sample patients...');
  const [pacienteJuan] = await Patient.create([
    {
      usuario: paciente1._id,
      sucursal: sucursalSantiago._id,
      rut: '12345678-9',
      nombre: 'Juan',
      apellido: 'Pérez',
      fechaNacimiento: new Date('1985-03-15'),
      direccion: {
        calle: 'Av. Providencia',
        numero: '1234',
        comuna: 'Providencia',
        ciudad: 'Santiago',
        region: 'Metropolitana',
      },
      telefono: '+56933333333',
      email: 'paciente1@dispensario.cl',
      medicoTratante: {
        nombre: 'Dr. Roberto Médico',
        especialidad: 'Medicina General',
        telefono: '+56944444444',
      },
      estado: 'aprobado',
      activadoPor: admin._id,
      fechaActivacion: new Date(),
      historialEstados: [
        { estado: 'pendiente', fecha: new Date(), motivo: 'Ficha creada (seed)' },
        { estado: 'aprobado', fecha: new Date(), usuario: admin._id, motivo: 'Documentos revisados (seed)' },
      ],
      // Archivo de ejemplo: no existe en disco, sirve solo para probar la vigencia
      documentos: [
        {
          tipo: 'receta_medica',
          nombre: 'Receta Dr. Roberto Médico',
          archivo: 'local:private/ejemplo-receta.pdf',
          fechaVencimiento: enUnAnio,
          estado: 'aprobado',
          revisadoPor: admin._id,
          fechaRevision: new Date(),
        },
      ],
      limiteMensualUnidades: 10,
    },
    {
      usuario: paciente2._id,
      rut: '98765432-1',
      nombre: 'María',
      apellido: 'González',
      fechaNacimiento: new Date('1990-07-22'),
      direccion: {
        calle: 'Los Leones',
        numero: '567',
        comuna: 'Las Condes',
        ciudad: 'Santiago',
        region: 'Metropolitana',
      },
      telefono: '+56955555555',
      email: 'paciente2@dispensario.cl',
      medicoTratante: {
        nombre: 'Dra. Ana Salud',
        especialidad: 'Neurología',
        telefono: '+56966666666',
      },
      sucursal: sucursalSantiago._id,
      estado: 'pendiente',
      historialEstados: [{ estado: 'pendiente', fecha: new Date(), motivo: 'Registro en el portal (seed)' }],
      limiteMensualUnidades: 0,
    },
  ]);

  console.log('Creating sample products (global catalog)...');
  const products = await Product.create([
    {
      nombre: 'Aceite CBD 10%',
      tipo: 'aceite',
      descripcion: 'Aceite de CBD al 10% de concentración',
      concentracion: '10%',
      presentacion: '30ml',
      usoTerapeutico: 'Dolor crónico, ansiedad',
      precio: 45000,
      lote: 'LOT-2603-A001',
      fechaProduccion: new Date('2026-01-15'),
      fechaVencimiento: new Date('2027-01-15'),
      cantidadDisponible: 0,
      estado: 'disponible',
    },
    {
      nombre: 'Crema CBD 5%',
      tipo: 'crema',
      descripcion: 'Crema tópica de CBD al 5%',
      concentracion: '5%',
      presentacion: '50g',
      usoTerapeutico: 'Dolor muscular, inflamación',
      precio: 35000,
      lote: 'LOT-2603-B002',
      fechaProduccion: new Date('2026-02-01'),
      fechaVencimiento: new Date('2027-02-01'),
      cantidadDisponible: 0,
      estado: 'disponible',
    },
    {
      nombre: 'Cápsulas CBD 25mg',
      tipo: 'capsula',
      descripcion: 'Cápsulas de CBD de 25mg cada una',
      concentracion: '25mg',
      presentacion: '30 cápsulas',
      usoTerapeutico: 'Epilepsia, insomnio',
      precio: 55000,
      lote: 'LOT-2603-C003',
      fechaProduccion: new Date('2026-02-15'),
      fechaVencimiento: new Date('2027-02-15'),
      cantidadDisponible: 0,
      estado: 'disponible',
    },
    {
      nombre: 'Tintura THC:CBD 1:1',
      tipo: 'tintura',
      descripcion: 'Tintura con ratio THC:CBD 1:1',
      concentracion: '1:1',
      presentacion: '15ml',
      usoTerapeutico: 'Dolor oncológico, náuseas',
      precio: 65000,
      lote: 'LOT-2603-D004',
      fechaProduccion: new Date('2026-03-01'),
      fechaVencimiento: new Date('2027-03-01'),
      cantidadDisponible: 0,
      estado: 'disponible',
    },
  ]);

  console.log('Creating stock per sucursal...');
  await SucursalStock.create([
    { sucursal: sucursalSantiago._id, producto: products[0]._id, cantidadDisponible: 60, lote: 'LOT-2603-A001', fechaVencimiento: new Date('2027-01-15') },
    { sucursal: sucursalSantiago._id, producto: products[1]._id, cantidadDisponible: 30, lote: 'LOT-2603-B002', fechaVencimiento: new Date('2027-02-01') },
    { sucursal: sucursalSantiago._id, producto: products[2]._id, cantidadDisponible: 50, lote: 'LOT-2603-C003', fechaVencimiento: new Date('2027-02-15') },
    { sucursal: sucursalSantiago._id, producto: products[3]._id, cantidadDisponible: 20, lote: 'LOT-2603-D004', fechaVencimiento: new Date('2027-03-01') },
    { sucursal: sucursalValpo._id, producto: products[0]._id, cantidadDisponible: 40, lote: 'LOT-2603-A001', precioLocal: 47000, fechaVencimiento: new Date('2027-01-15') },
    { sucursal: sucursalValpo._id, producto: products[1]._id, cantidadDisponible: 20, lote: 'LOT-2603-B002', fechaVencimiento: new Date('2027-02-01') },
    { sucursal: sucursalValpo._id, producto: products[2]._id, cantidadDisponible: 25, lote: 'LOT-2603-C003', fechaVencimiento: new Date('2027-02-15') },
  ]);

  console.log('Creating locations and a cultivation space...');
  const [sala] = await Ubicacion.create([
    { sucursal: sucursalSantiago._id, nombre: 'Sala de cultivo 1', codigo: 'SALA-1', tipo: 'sala_cultivo' },
    { sucursal: sucursalSantiago._id, nombre: 'Bodega principal', codigo: 'BOD-1', tipo: 'bodega' },
    { sucursal: sucursalSantiago._id, nombre: 'Mesón de dispensación', codigo: 'DISP-1', tipo: 'dispensario' },
  ]);

  await EspacioCultivo.create({
    sucursal: sucursalSantiago._id,
    paciente: pacienteJuan._id,
    ubicacion: sala._id,
    codigo: generateCode('ESP'),
    codigoQR: generateQRToken(),
    metrosCuadrados: 1,
    flor: 'Variedad ejemplo (CBD alto)',
    creadoPor: admin._id,
  });

  console.log('Seed completed successfully!');
  console.log('---');
  console.log('Sucursales: Santiago Centro (SCL), Valparaíso (VLP)');
  console.log('Admin: admin@dispensario.cl / admin123 (ambas sucursales)');
  console.log('Operador: operador@dispensario.cl / operador123 (Santiago)');
  console.log('Producción: produccion@dispensario.cl / produccion123 (ambas)');
  console.log('Finanzas: finanzas@dispensario.cl / finanzas123 (ambas)');
  console.log('Cultivo: cultivo@dispensario.cl / cultivo123 (Santiago)');
  console.log('Paciente 1: paciente1@dispensario.cl / paciente123');
  console.log('Paciente 2: paciente2@dispensario.cl / paciente123');
  process.exit(0);
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
