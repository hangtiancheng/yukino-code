export function applyTheme(dark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("mocha", dark);
  root.classList.toggle("latte", !dark);
  root.style.colorScheme = dark ? "dark" : "light";
}
