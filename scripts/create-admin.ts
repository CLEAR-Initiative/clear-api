import { auth } from "../src/lib/auth.js";
import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/utils/env.js";

async function createAdmin() {
  console.log("Creating admin user...");
  
  try {
    // Check if admin exists
    const existing = await prisma.user.findUnique({
      where: { email: env.ADMIN_EMAIL },
    });

    if (existing) {
      console.log("Admin user already exists, updating role and verifying email...");
      await prisma.user.update({
        where: { id: existing.id },
        data: { role: "admin", emailVerified: true },
      });
      console.log(`✓ Admin user updated: ${env.ADMIN_EMAIL}`);
      return;
    }

    // Create new admin user via Better Auth
    const signup = await auth.api.signUpEmail({
      body: {
        name: "Admin User",
        email: env.ADMIN_EMAIL,
        password: env.ADMIN_PASSWORD,
      },
    });

    // Update role to admin and verify email
    await prisma.user.update({
      where: { id: signup.user.id },
      data: { role: "admin", emailVerified: true },
    });

    console.log(`✓ Admin user created successfully!`);
    console.log(`  Email: ${env.ADMIN_EMAIL}`);
    console.log(`  Password: ${env.ADMIN_PASSWORD}`);
  } catch (error) {
    console.error("Error creating admin user:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

createAdmin();
