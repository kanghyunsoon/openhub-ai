import { setDesktopLocale } from "../src/i18n/index";

/**
 * 기존 Desktop 테스트(v0.2.0 이전)는 한국어 화면을 기준으로 쓰여 있다. 이 파일을 import한 테스트는 Desktop 언어를 ko로 고정한다.
 * 제품 기본값(저장값 > OS 언어 > English)은 i18n 테스트가 따로 검증한다.
 */
setDesktopLocale("ko");
