import './styles.css';
import { mountBattleCity } from './app/bootstrap';

export const application = mountBattleCity(document.querySelector<HTMLDivElement>('#app')!);
if (import.meta.hot) import.meta.hot.dispose(() => { void application.dispose(); });
