import { connectDB } from './config/database';
import { User } from './models/User';
import { Patient } from './models/Patient';
import { Product } from './models/Product';

async function seed() {
  await connectDB();

  console.log('Cleaning database...');
  await User.deleteMany({});
  await Patient.deleteMany({});
  await Product.deleteMany({});

  console.log('Creating admin user...');
  const admin = await User.create({
    email: 'admin@dispensario.cl',
    password: 'admin123',
    nombre: 'Administrador',
    apellido: 'Sistema',
    rut: '11111111-1',
    role: 'admin',
    telefono: '+56912345678',
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

  console.log('Creating sample patients...');
  await Patient.create([
    {
      usuario: paciente1._id,
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
      limiteCompra: 500000,
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
      estado: 'pendiente',
      limiteCompra: 300000,
    },
  ]);

  console.log('Creating sample products...');
  await Product.create([
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
      cantidadDisponible: 100,
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
      cantidadDisponible: 50,
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
      cantidadDisponible: 75,
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
      cantidadDisponible: 30,
      estado: 'disponible',
    },
  ]);

  console.log('Seed completed successfully!');
  console.log('---');
  console.log('Admin: admin@dispensario.cl / admin123');
  console.log('Operador: operador@dispensario.cl / operador123');
  console.log('Producción: produccion@dispensario.cl / produccion123');
  console.log('Finanzas: finanzas@dispensario.cl / finanzas123');
  console.log('Paciente 1: paciente1@dispensario.cl / paciente123');
  console.log('Paciente 2: paciente2@dispensario.cl / paciente123');
  process.exit(0);
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
