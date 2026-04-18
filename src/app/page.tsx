import LoginGate from "@/components/login/LoginGate";
import WorkflowRouter from "@/components/WorkflowRouter";

export default function Home() {
  return (
    <LoginGate>
      <WorkflowRouter />
    </LoginGate>
  );
}
