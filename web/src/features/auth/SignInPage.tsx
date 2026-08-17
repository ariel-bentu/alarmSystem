// Sign-in page: shown when user is not authenticated.
import { useAuth } from "@/app/AuthProvider";

export default function SignInPage() {
  const { signIn } = useAuth();

  return (
    <div className="sign-in-page">
      <h1>Alarm System</h1>
      <p>Sign in to manage your alarm system.</p>
      <button onClick={signIn} type="button">
        Sign in with Google
      </button>
    </div>
  );
}
