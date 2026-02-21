import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IRoom extends Document {
    adminId: Types.ObjectId;
    roomId: string;
    isActive: boolean;
}

const roomSchema = new Schema<IRoom>(
    {
        adminId: { type: Schema.Types.ObjectId, ref: 'Admin', required: true },
        roomId: { type: String, required: true, unique: true },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

export const Room = mongoose.model<IRoom>('Room', roomSchema);
