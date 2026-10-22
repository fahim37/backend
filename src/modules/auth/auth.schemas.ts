import { z } from "zod";
import { cmsImageSchema } from "../../schemas/common.js";

export const PASSWORD_MIN_LENGTH = 10;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(200, "Use at most 200 characters");

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")).pipe(z.string().max(254));

export const loginSchema = z.object({
  email: emailSchema,
  // Not length-checked here: an old password shorter than today's minimum must still be able to sign in.
  password: z.string().min(1, "Required").max(200),
});

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1, "Required").max(120).optional(),
    avatar: cmsImageSchema.nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.avatar !== undefined, { message: "Nothing to update" });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Required").max(200),
    newPassword: passwordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "Choose a password different from the current one",
    path: ["newPassword"],
  });
