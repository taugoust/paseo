// Expo Router 57 owns its navigation contexts. The separately installed
// @react-navigation/native hook cannot observe the browser router's provider.
// Keep this platform-specific so installed/native clients retain their hook.
export { useIsFocused } from "expo-router/react-navigation";
