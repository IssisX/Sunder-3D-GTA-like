import { createFileRoute } from "@tanstack/react-router";
import { SunderApp } from "@/components/sunder-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <SunderApp />;
}
