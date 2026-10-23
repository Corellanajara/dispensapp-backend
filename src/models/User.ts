import mongoose, { Schema, Document, Types } from 'mongoose';
import bcrypt from 'bcryptjs';

export type UserRole = 'admin' | 'operador' | 'produccion' | 'cultivo' | 'finanzas' | 'paciente';

export const USER_ROLES: UserRole[] = ['admin', 'operador', 'produccion', 'cultivo', 'finanzas', 'paciente'];

export interface IUser extends Document {
  email: string;
  password: string;
  nombre: string;
  apellido: string;
  rut: string;
  role: UserRole;
  telefono?: string;
  sucursales: Types.ObjectId[];
  sucursalActiva?: Types.ObjectId;
  activo: boolean;
  ultimoAcceso?: Date;
  intentosFallidos: number;
  bloqueadoHasta?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    nombre: {
      type: String,
      required: true,
      trim: true,
    },
    apellido: {
      type: String,
      required: true,
      trim: true,
    },
    rut: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    role: {
      type: String,
      enum: USER_ROLES,
      default: 'operador',
    },
    telefono: {
      type: String,
      trim: true,
    },
    sucursales: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Sucursal',
      },
    ],
    sucursalActiva: {
      type: Schema.Types.ObjectId,
      ref: 'Sucursal',
    },
    activo: {
      type: Boolean,
      default: true,
    },
    ultimoAcceso: {
      type: Date,
    },
    intentosFallidos: {
      type: Number,
      default: 0,
    },
    bloqueadoHasta: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const { password: _, intentosFallidos: _i, ...rest } = ret;
    return rest;
  },
});

export const User = mongoose.model<IUser>('User', userSchema);
