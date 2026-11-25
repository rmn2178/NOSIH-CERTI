import "../env.js"; // loads the repository-root .env — must come first
import bcrypt from "bcryptjs";
import { supabase } from "../supabase.js";

const BCRYPT_ROUNDS = 12;

/**
 * Seeds (or repairs) the NOSIH platform admin from ADMIN_EMAIL /
 * ADMIN_PASSWORD in the root .env. Idempotent: re-running rotates the
 * password and guarantees the platform_admin role.
 */
async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required in the root .env");
  }
  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must be at least 8 characters");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const { data: existing, error: findError } = await supabase
    .from("users")
    .select("*")
    .eq("email", email)
    .maybeSingle();
  if (findError) throw new Error(findError.message);

  if (!existing) {
    const { error } = await supabase.from("users").insert({
      email,
      password_hash: passwordHash,
      role: "platform_admin",
      active: true,
      organization_name: "NOSIH",
    });
    if (error) throw new Error(error.message);
    console.log(`Created platform admin: ${email}`);
  } else {
    const { error } = await supabase
      .from("users")
      .update({
        password_hash: passwordHash,
        role: "platform_admin",
        active: true,
        organization_name: existing.organization_name || "NOSIH",
      })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    console.log(`Updated platform admin: ${email}`);
  }
}

seedAdmin()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Admin seed failed:", error.message);
    process.exit(1);
  });