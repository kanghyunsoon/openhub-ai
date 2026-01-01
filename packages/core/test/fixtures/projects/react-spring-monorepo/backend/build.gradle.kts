plugins {
    java
    id("org.springframework.boot") version "3.5.0"
    id("io.spring.dependency-management") version "1.1.7"
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    // implementation("org.postgresql:postgresql")  주석은 무시된다
    runtimeOnly("com.mysql:mysql-connector-j")
}
