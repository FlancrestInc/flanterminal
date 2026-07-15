const LOGO_URL = `${import.meta.env.BASE_URL}flanterminal.png`;

export function AuthBrand() {
  return (
    <div className="auth-brand">
      <img
        className="auth-brand-mark"
        src={LOGO_URL}
        alt=""
        width={40}
        height={40}
      />
      <span>FlanTerminal</span>
    </div>
  );
}
