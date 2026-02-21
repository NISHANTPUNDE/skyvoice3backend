import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUser extends Document {
    name: string;
    phone: string;
    passwordHash: string;
    adminId: Types.ObjectId;
    deviceId: string | null;
    isDeleted: boolean;
}

const userSchema = new Schema<IUser>(
    {
        name: { type: String, required: true, trim: true },
        phone: { type: String, required: true, unique: true, trim: true },
        passwordHash: { type: String, required: true },
        adminId: { type: Schema.Types.ObjectId, ref: 'Admin', required: true },
        deviceId: { type: String, default: null },
        isDeleted: { type: Boolean, default: false },
    },
    { timestamps: true }
);

export const User = mongoose.model<IUser>('User', userSchema);
