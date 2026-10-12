import { PageTransition } from "@/components/motion";

/** Re-mounts on every dashboard navigation, so each page fades in inside the shell. */
export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  return <PageTransition>{children}</PageTransition>;
}
