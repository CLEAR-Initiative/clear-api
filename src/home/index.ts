import { Router } from "express";
import { renderHomePage } from "./template.js";

export const homeRouter = Router();

homeRouter.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderHomePage());
});
