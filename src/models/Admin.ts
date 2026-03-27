import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAdmin extends Document {
    name: string;
    username: string;
    passwordHash: string;
    encryptedPassword: string;
    createdBy: Types.ObjectId;
    isActive: boolean;
    userLimit: number;
    subdomain?: string;
    logoUrl?: string;
}

const adminSchema = new Schema<IAdmin>(
    {
        name: { type: String, required: true, trim: true },
        username: { type: String, required: true, unique: true, lowercase: true, trim: true },
        passwordHash: { type: String, required: true },
        encryptedPassword: { type: String, default: '' },
        createdBy: { type: Schema.Types.ObjectId, ref: 'SuperAdmin', required: true },
        isActive: { type: Boolean, default: true },
        userLimit: { type: Number, default: 0 },
        subdomain: { type: String, unique: true, sparse: true, trim: true },
        logoUrl: { type: String, default: '' },
    },
    { timestamps: true }
);

export const Admin = mongoose.model<IAdmin>('Admin', adminSchema);

