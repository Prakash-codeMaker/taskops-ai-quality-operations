import { auth } from "hatchable";

export const access = "public";
export const methods = ["GET"];

export default async function (req, res) {
  try {
    const user = await auth.getUser(req);
    res.json({
      authenticated: !!user,
      user: user ? { email:user.email, name:user.name, image:user.image } : null
    });
  } catch (error) {
    res.status(500).json({ error:"Unable to inspect the current session." });
  }
}