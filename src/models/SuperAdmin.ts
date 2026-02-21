import mongoose, { Schema, Document } from 'mongoose';

export interface ISuperAdmin extends Document {
    email: string;
    passwordHash: string;
}

const superAdminSchema = new Schema<ISuperAdmin>(
    {
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        passwordHash: { type: String, required: true },
    },
    { timestamps: true }
);

export const SuperAdmin = mongoose.model<ISuperAdmin>('SuperAdmin', superAdminSchema);
