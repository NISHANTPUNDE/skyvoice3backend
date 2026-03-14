import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUser extends Document {
    name: string;
    username: string;
    phone: string;
    passwordHash: string;
    encryptedPassword: string;
    adminId: Types.ObjectId;
    deviceId: string | null;
    isDeleted: boolean;
}

const userSchema = new Schema<IUser>(
    {
        name: { type: String, required: true, trim: true },
        username: { type: String, required: true, lowercase: true, trim: true },
        phone: { type: String, default: '', trim: true },
        passwordHash: { type: String, required: true },
        encryptedPassword: { type: String, default: '' },
        adminId: { type: Schema.Types.ObjectId, ref: 'Admin', required: true },
        deviceId: { type: String, default: null },
        isDeleted: { type: Boolean, default: false },
    },
    { timestamps: true }
);

// Same username can exist under different admins, but must be unique per admin
userSchema.index({ username: 1, adminId: 1 }, { unique: true });

export const User = mongoose.model<IUser>('User', userSchema);
