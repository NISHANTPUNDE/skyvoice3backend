import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAdmin extends Document {
    name: string;
    username: string;
    passwordHash: string;
    createdBy: Types.ObjectId;
    isActive: boolean;
}

const adminSchema = new Schema<IAdmin>(
    {
        name: { type: String, required: true, trim: true },
        username: { type: String, required: true, unique: true, lowercase: true, trim: true },
        passwordHash: { type: String, required: true },
        createdBy: { type: Schema.Types.ObjectId, ref: 'SuperAdmin', required: true },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

export const Admin = mongoose.model<IAdmin>('Admin', adminSchema);
